const { safeEqual } = require('../lib/auth');
const { tgApi, sendRichMessage, editRichMessage, answerCallbackQuery } = require('../lib/telegram');
const { addDays, getSchedule } = require('../lib/schedule');
const { HELP, formatDay, formatWeek, navKeyboard } = require('../lib/format');

let username = null;

async function botUsername() {
  if (username) return username;
  username = String((await tgApi('getMe', {})).username || '').toLowerCase();
  return username;
}

async function scheduleDay(date, { refresh = false } = {}) {
  const payload = await getSchedule({ force: refresh });
  return { payload, html: formatDay(payload, date) };
}

async function sendCommand(chatId, command) {
  if (command === 'start' || command === 'help') return sendRichMessage(chatId, HELP, {
    inline_keyboard: [[
      { text: 'Сегодня', callback_data: 'd:today' },
      { text: 'Завтра', callback_data: 'd:tomorrow' },
      { text: 'Неделя', callback_data: 'w' },
    ]],
  });
  const initial = await getSchedule();
  const date = command === 'today' ? initial.today : command === 'tomorrow' ? addDays(initial.today, 1) : null;
  if (date) return sendRichMessage(chatId, formatDay(initial, date), navKeyboard(date, initial.today));
  if (command === 'week') return sendRichMessage(chatId, formatWeek(initial), {
    inline_keyboard: [[{ text: 'Сегодня', callback_data: 'd:today' }, { text: 'Обновить', callback_data: 'w' }]],
  });
  return null;
}

async function handleCallback(callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = String(callback.data || '');
  try {
    if (!chatId || !messageId) return;
    if (data === 'w') {
      const payload = await getSchedule({ force: true });
      await editRichMessage(chatId, messageId, formatWeek(payload), {
        inline_keyboard: [[{ text: 'Сегодня', callback_data: 'd:today' }, { text: 'Обновить', callback_data: 'w' }]],
      });
      return;
    }
    const match = /^(d|r):(today|tomorrow|\d{4}-\d{2}-\d{2})$/.exec(data);
    if (!match) return;
    const force = match[1] === 'r';
    const payload = await getSchedule({ force });
    const date = match[2] === 'today' ? payload.today : match[2] === 'tomorrow' ? addDays(payload.today, 1) : match[2];
    await editRichMessage(chatId, messageId, formatDay(payload, date), navKeyboard(date, payload.today));
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
    { command: 'today', description: 'Расписание на сегодня' },
    { command: 'tomorrow', description: 'Расписание на завтра' },
    { command: 'week', description: 'Расписание на неделю' },
    { command: 'help', description: 'Помощь' },
  ] });
  res.status(200).json({ ok: true, webhook, commands });
}

module.exports = async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !process.env.TELEGRAM_BOT_TOKEN) return res.status(503).json({ ok: false, error: 'not_configured' });
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
