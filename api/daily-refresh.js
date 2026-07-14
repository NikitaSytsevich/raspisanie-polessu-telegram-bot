const { safeEqual } = require('../lib/auth');
const { getSchedule } = require('../lib/schedule');
const { formatDay, navKeyboard } = require('../lib/format');
const { editRichMessage } = require('../lib/telegram');
const { dashboardStore } = require('../lib/dashboard-store');
const { refreshDashboards } = require('../lib/daily-refresh');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const authorization = String(req.headers?.authorization || '');
  if (req.method !== 'GET') return res.status(405).json({ ok: false });
  if (!secret || !safeEqual(authorization, `Bearer ${secret}`)) return res.status(401).json({ ok: false });

  try {
    const payload = await getSchedule({ force: true });
    const result = await refreshDashboards({
      store: dashboardStore(),
      html: formatDay(payload, payload.today),
      replyMarkup: navKeyboard(payload.today, payload.today),
      edit: editRichMessage,
    });
    return res.status(200).json({ ok: true, date: payload.today, ...result });
  } catch (error) {
    console.error('[daily-refresh] failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
