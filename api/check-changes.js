const { safeEqual } = require('../lib/auth');
const { currentTime, getSchedule } = require('../lib/schedule');
const { ACK_KEYBOARD, cardView } = require('../lib/format');
const { dashboardStore } = require('../lib/dashboard-store');
const { refreshDashboards, isChatGoneError, inBatches } = require('../lib/daily-refresh');
const { planCheck, formatChangeAlert } = require('../lib/change-monitor');
const { subscribedChanges } = require('../lib/subscriptions');
const { editRichMessage, sendRichMessage } = require('../lib/telegram');

// Уведомление уходит всем чатам с подпиской на затронутый объект — и тем, кто
// удалил карточку: подписка от карточки не зависит.
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
      if (isChatGoneError(error)) await store.remove(dashboard.chatId);
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
    const store = dashboardStore();
    // Свежий разбор заодно ложится в Redis: кнопки следующие десять минут
    // берут его оттуда, а не качают страницы сами.
    const [payload, dashboards, stored] = await Promise.all([
      getSchedule({ force: true, store }),
      store.list(),
      store.getSnapshot(),
    ]);
    const plan = planCheck(stored, payload, currentTime());
    if (plan.refresh) {
      await refreshDashboards({
        store,
        dashboards,
        render: dashboard => cardView(payload, dashboard),
        edit: editRichMessage,
      });
    }
    // Карточку обновляем всем, а сообщение об изменениях уходит только тем,
    // кто подписан на затронутый объект.
    const notifications = plan.notify.length ? await notifyDashboards(store, dashboards, plan.notify) : 0;
    // Снимок сохраняем только после рассылки: если функция упадёт или упрётся
    // в maxDuration раньше, следующая проверка найдёт те же изменения заново.
    await store.saveSnapshot(plan.save);
    return res.status(200).json({
      ok: true,
      baseline: plan.baseline,
      dayChanged: plan.dayChanged,
      changed: plan.changes.length,
      pending: Boolean(plan.save.pending),
      notifications,
    });
  } catch (error) {
    console.error('[check-changes] failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
