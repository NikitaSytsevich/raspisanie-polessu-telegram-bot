const { safeEqual } = require('../lib/auth');
const { getSchedule } = require('../lib/schedule');
const { formatDay, navKeyboard } = require('../lib/format');
const { dashboardStore } = require('../lib/dashboard-store');
const { refreshDashboards, isRemovedDashboardError } = require('../lib/daily-refresh');
const { scheduleSnapshot, diffSchedules, formatChangeAlert } = require('../lib/change-monitor');
const { editRichMessage, sendRichMessage } = require('../lib/telegram');

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
    return res.status(200).json({ ok: true, baseline: !previous, dayChanged, changed: changes.length, notifications });
  } catch (error) {
    console.error('[check-changes] failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
