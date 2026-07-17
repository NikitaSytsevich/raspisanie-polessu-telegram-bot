const { safeEqual } = require('../lib/auth');
const { tgApi, sendRichMessage, editRichMessage, answerCallbackQuery } = require('../lib/telegram');
const { addDays, getSchedule } = require('../lib/schedule');
const { SOURCES, formatDay, navKeyboard, sourcesKeyboard } = require('../lib/format');
const { dashboardStore } = require('../lib/dashboard-store');

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
  let toast;
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
    // Тост подтверждаем только после успешного обновления карточки.
    if (force) toast = 'Расписание обновлено ✓';
  } finally {
    await answerCallbackQuery(callback.id, toast).catch(() => {});
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
  const description = await tgApi('setMyDescription', {
    description: 'Расписание спортивных объектов ПолесГУ: ледовая арена, большой и малый бассейны, гребная база. Данные загружаются с официального сайта университета, а при изменениях бот присылает сводку.',
  });
  const shortDescription = await tgApi('setMyShortDescription', {
    short_description: 'Расписание спортобъектов ПолесГУ с официального сайта',
  });
  res.status(200).json({ ok: true, webhook, commands, description, shortDescription });
}

module.exports = async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!secret || !process.env.TELEGRAM_BOT_TOKEN || !redisUrl || !redisToken) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }
  const setupToken = new URL(req.url || '/', `https://${req.headers?.host || 'localhost'}`).searchParams.get('setup') || '';
  if (req.method === 'GET' && safeEqual(setupToken, secret)) {
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
        // Updates адресованных другим ботам сюда не поступают, поэтому не
        // запрашиваем getMe: это исключает лишнюю точку отказа для /start.
        await sendCommand(update.message.chat.id, match[1].toLowerCase());
      }
    }
  } catch (error) {
    // Telegram повторит update после не-2xx: не создаём лавину дублей.
    console.error('[telegram] update failed:', error.message);
  }
  res.status(200).json({ ok: true });
};
