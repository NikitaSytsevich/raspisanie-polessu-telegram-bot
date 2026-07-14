const { safeEqual } = require('../lib/auth');
const { tgApi, sendRichMessage, editRichMessage, answerCallbackQuery } = require('../lib/telegram');
const { addDays, getSchedule } = require('../lib/schedule');
const { SOURCES, formatDay, navKeyboard, sourcesKeyboard } = require('../lib/format');
const { dashboardStore } = require('../lib/dashboard-store');

let username = null;

async function botUsername() {
  if (username) return username;
  username = String((await tgApi('getMe', {})).username || '').toLowerCase();
  return username;
}

async function sendCommand(chatId, command) {
  if (command !== 'start' && command !== 'help') return null;
  const initial = await getSchedule();
  const html = formatDay(initial, initial.today);
  const replyMarkup = navKeyboard(initial.today, initial.today);
  const store = dashboardStore();
  const existing = await store.get(chatId);
  if (existing) {
    try {
      await editRichMessage(chatId, existing.messageId, html, replyMarkup);
      return existing;
    } catch (error) {
      if (/message is not modified/i.test(error.message)) return existing;
      // Пользователь мог удалить карточку вручную. Создаём её заново и заменяем ID.
      if (!/message to edit not found/i.test(error.message)) throw error;
    }
  }
  const message = await sendRichMessage(chatId, html, replyMarkup);
  await store.save(chatId, message.message_id);
  return message;
}

async function handleCallback(callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = String(callback.data || '');
  try {
    if (!chatId || !messageId) return;
    const source = /^s:(\d{4}-\d{2}-\d{2}):(all|ice_arena|sports_pool|small_pool|rowing_base)$/.exec(data);
    if (source) {
      const payload = await getSchedule();
      await editRichMessage(chatId, messageId, SOURCES, sourcesKeyboard(payload, source[1], source[2]));
      return;
    }
    const dayAction = /^(d|r):(today|tomorrow|\d{4}-\d{2}-\d{2}):(all|ice_arena|sports_pool|small_pool|rowing_base)$/.exec(data);
    const facilityAction = /^f:(all|ice_arena|sports_pool|small_pool|rowing_base):(\d{4}-\d{2}-\d{2})$/.exec(data);
    if (!dayAction && !facilityAction) return;
    const force = dayAction?.[1] === 'r';
    const payload = await getSchedule({ force });
    const rawDate = facilityAction ? facilityAction[2] : dayAction[2];
    const rawSelected = facilityAction ? facilityAction[1] : dayAction[3];
    const date = rawDate === 'today' ? payload.today : rawDate === 'tomorrow' ? addDays(payload.today, 1) : rawDate;
    const selected = rawSelected === 'all' || payload.facilities.some(facility => facility.id === rawSelected) ? rawSelected : 'all';
    await editRichMessage(chatId, messageId, formatDay(payload, date, selected), navKeyboard(date, payload.today, selected));
  } finally {
    await answerCallbackQuery(callback.id).catch(() => {});
  }
}

async function setup(req, res) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is not configured');
  const webhook = await tgApi('setWebhook', {
    url: `${appUrl.replace(/\/$/, '')}/api/telegram`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  const commands = await tgApi('setMyCommands', { commands: [
    { command: 'start', description: 'Открыть расписание' },
  ] });
  res.status(200).json({ ok: true, webhook, commands });
}

module.exports = async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!secret || !process.env.TELEGRAM_BOT_TOKEN || !redisUrl || !redisToken) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }
  if (req.method === 'GET' && safeEqual(String(req.query?.setup || ''), secret)) {
    try { await setup(req, res); } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
    return;
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!safeEqual(String(req.headers?.['x-telegram-bot-api-secret-token'] || ''), secret)) return res.status(401).json({ ok: false });

  try {
    const update = req.body || {};
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message?.text) {
      const match = /^\/([a-z_]+)(?:@(\w+))?(?:\s|$)/i.exec(update.message.text.trim());
      if (match) {
        const mentioned = String(match[2] || '').toLowerCase();
        if (!mentioned || mentioned === await botUsername()) {
          await sendCommand(update.message.chat.id, match[1].toLowerCase());
        }
      }
    }
  } catch (error) {
    // Telegram повторит update после не-2xx: не создаём лавину дублей.
    console.error('[telegram] update failed:', error.message);
  }
  res.status(200).json({ ok: true });
};
