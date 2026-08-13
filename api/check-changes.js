const { safeEqual } = require('../lib/auth');
const { getSchedule } = require('../lib/schedule');
const { ACK_KEYBOARD, cardView } = require('../lib/format');
const { dashboardStore } = require('../lib/dashboard-store');
const { refreshDashboards, isRemovedDashboardError, inBatches } = require('../lib/daily-refresh');
const { SNAPSHOT_VERSION, scheduleSnapshot, diffSchedules, formatChangeAlert } = require('../lib/change-monitor');
const { subscribedChanges } = require('../lib/subscriptions');
const { deleteMessage, editRichMessage, sendRichMessage } = require('../lib/telegram');

// Разовая уборка после утренней сводки: её последнее сообщение висит в чатах, а
// удалять Telegram даёт только первые 48 часов. Проверка приходит каждые десять
// минут и знает все зарегистрированные чаты, поэтому успевает до срока — в
// отличие от /start, которого пользователь может не отправить неделю. Пройдя
// один раз, уборка выключает себя флагом и больше по чатам не ходит.
async function clearDigests(store, dashboards) {
  let cleared = 0;
  await inBatches(dashboards, async dashboard => {
    const messageId = await store.takeDigestMessageId(dashboard.chatId).catch(() => null);
    if (!messageId) return;
    await deleteMessage(dashboard.chatId, messageId).catch(() => {});
    cleared += 1;
  });
  await store.finishDigestCleanup();
  return cleared;
}

async function notifyDashboards(store, dashboards, changes) {
  // Текст зависит только от набора объектов, попавших в подписку чата, —
  // собираем разметку по разу на набор, а не на каждый чат.
  const rendered = new Map();
  let sent = 0;
  await inBatches(dashboards, async dashboard => {
    const relevant = subscribedChanges(changes, dashboard.facilities);
    if (!relevant.length) return;
    const key = relevant.map(change => change.facility.id).join('|');
    if (!rendered.has(key)) rendered.set(key, formatChangeAlert(relevant));
    try {
      await sendRichMessage(dashboard.chatId, rendered.get(key), ACK_KEYBOARD);
      sent += 1;
    } catch (error) {
      if (isRemovedDashboardError(error)) await store.remove(dashboard.chatId);
      else console.error(`[check-changes] notification ${dashboard.chatId}:`, error.message);
    }
  });
  return sent;
}

module.exports = async (req, res) => {
  const secret = process.env.CHANGE_CHECK_SECRET;
  const authorization = String(req.headers?.authorization || '');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!secret || !safeEqual(authorization, `Bearer ${secret}`)) return res.status(401).json({ ok: false });

  try {
    const payload = await getSchedule({ force: true });
    const store = dashboardStore();
    const dashboards = await store.list();
    const next = scheduleSnapshot(payload);
    const stored = await store.getSnapshot();
    // Снимок старого формата сравнивать не с чем: молча сохраняем новый.
    const previous = stored?.version === SNAPSHOT_VERSION ? stored : null;
    const changes = previous ? diffSchedules(previous, next) : [];

    // Первая проверка нового дня обновляет карточки даже без изменений:
    // иначе до первого нажатия кнопки они показывают вчерашнюю дату.
    const dayChanged = !previous || previous.today !== next.today;
    if (dayChanged || changes.length) {
      await refreshDashboards({
        store,
        dashboards,
        render: dashboard => cardView(payload, dashboard),
        edit: editRichMessage,
      });
    }
    // Карточку обновляем всем, а сообщение об изменениях уходит только тем,
    // кто подписан на затронутый объект.
    const notifications = changes.length ? await notifyDashboards(store, dashboards, changes) : 0;
    // Снимок сохраняем только после рассылки: если функция упадёт или упрётся
    // в maxDuration раньше, следующая проверка найдёт те же изменения заново.
    await store.saveSnapshot(next);
    const digestsCleared = await store.digestCleanupPending() ? await clearDigests(store, dashboards) : 0;
    return res.status(200).json({ ok: true, baseline: !previous, dayChanged, changed: changes.length, notifications, digestsCleared });
  } catch (error) {
    console.error('[check-changes] failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
