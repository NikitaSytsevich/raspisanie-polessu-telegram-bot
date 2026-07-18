const { safeEqual } = require('../lib/auth');
const { getSchedule } = require('../lib/schedule');
const { formatDay, formatMorningDigest, navKeyboard } = require('../lib/format');
const { dashboardStore } = require('../lib/dashboard-store');
const { refreshDashboards, isRemovedDashboardError } = require('../lib/daily-refresh');
const { scheduleSnapshot, diffSchedules, formatChangeAlert } = require('../lib/change-monitor');
const { editRichMessage, sendRichMessage, deleteMessage } = require('../lib/telegram');

function minskHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Minsk', hour: '2-digit', hour12: false,
  }).format(new Date()));
}

async function sendMorningDigests(store, html) {
  const dashboards = await store.list();
  let sent = 0;
  await Promise.all(dashboards.map(async dashboard => {
    try {
      // В чате живёт ровно одна сводка: вчерашнюю удаляем, новую шлём без звука.
      const previousDigest = await store.getDigestMessageId(dashboard.chatId);
      if (previousDigest) await deleteMessage(dashboard.chatId, previousDigest).catch(() => {});
      const message = await sendRichMessage(dashboard.chatId, html, undefined, { silent: true });
      await store.saveDigestMessageId(dashboard.chatId, message.message_id);
      sent += 1;
    } catch (error) {
      if (isRemovedDashboardError(error)) await store.remove(dashboard.chatId);
      else console.error(`[check-changes] digest ${dashboard.chatId}:`, error.message);
    }
  }));
  return { sent, total: dashboards.length };
}

async function notifyDashboards(store, html) {
  const dashboards = await store.list();
  let sent = 0;
  await Promise.all(dashboards.map(async dashboard => {
    try {
      await sendRichMessage(dashboard.chatId, html);
      sent += 1;
    } catch (error) {
      if (isRemovedDashboardError(error)) await store.remove(dashboard.chatId);
      else console.error(`[check-changes] notification ${dashboard.chatId}:`, error.message);
    }
  }));
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
    const next = scheduleSnapshot(payload);
    const previous = await store.getSnapshot();
    const changes = previous ? diffSchedules(previous, next) : [];
    await store.saveSnapshot(next);

    // Первая проверка нового дня обновляет карточки даже без изменений:
    // иначе до первого нажатия кнопки они показывают вчерашнюю дату.
    const dayChanged = !previous || previous.today !== next.today;
    if (dayChanged || changes.length) {
      await refreshDashboards({
        store,
        html: formatDay(payload, payload.today),
        replyMarkup: navKeyboard(payload.today, payload.today),
        edit: editRichMessage,
      });
    }
    const notifications = changes.length ? await notifyDashboards(store, formatChangeAlert(changes)) : 0;
    // Проверки идут круглосуточно, поэтому сводка не привязана к смене дня
    // (иначе приходила бы в полночь): шлём раз в день первой проверкой
    // после 8:00 по Минску. Дату последней сводки храним отдельно.
    let digests = 0;
    if (minskHour() >= 8 && await store.getDigestDate() !== payload.today) {
      const result = await sendMorningDigests(store, formatMorningDigest(payload));
      digests = result.sent;
      // При сбое отправки дату не сохраняем — следующая проверка повторит.
      if (result.sent > 0 || result.total === 0) await store.saveDigestDate(payload.today);
    }
    return res.status(200).json({ ok: true, baseline: !previous, dayChanged, changed: changes.length, notifications, digests });
  } catch (error) {
    console.error('[check-changes] failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
