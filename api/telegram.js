const { safeEqual } = require('../lib/auth');
const { tgApi, sendRichMessage, editRichMessage, answerCallbackQuery, deleteMessage } = require('../lib/telegram');
const { getSchedule } = require('../lib/schedule');
const { formatDay, formatNotifications, navKeyboard, notificationsKeyboard } = require('../lib/format');
const { ALL_FACILITY_IDS, toggleSubscription } = require('../lib/subscriptions');
const { dashboardStore } = require('../lib/dashboard-store');

const FACILITY_IDS = ALL_FACILITY_IDS.join('|');
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const DAY_ACTION_RE = new RegExp(`^(d|r):(${DATE}):(all|${FACILITY_IDS})$`);
const FACILITY_ACTION_RE = new RegExp(`^f:(all|${FACILITY_IDS}):(${DATE})$`);
const NOTIFY_ACTION_RE = new RegExp(`^n:(menu|all|off|${FACILITY_IDS}):(${DATE}):(all|${FACILITY_IDS})$`);

async function sendCommand(chatId, command) {
  if (command !== 'start' && command !== 'help') return null;
  const store = dashboardStore();
  const existing = await store.get(chatId);
  const payload = await getSchedule();
  // Карточка открывается на том же объекте, что и в прошлый раз. Если объект
  // не выбран, но в уведомлениях отмечен ровно один — открываем сразу на нём:
  // «мой объект» задаётся один раз в настройках и работает на обоих экранах.
  const chosen = existing?.view && existing.view !== 'all' ? existing.view : null;
  const selected = chosen || (existing?.facilities?.length === 1 ? existing.facilities[0] : 'all');
  // Старую карточку не редактируем, а пересоздаём: после очистки истории
  // «только у себя» она жива для бота, но невидима для пользователя — и
  // успешное редактирование выглядело бы как молчание в ответ на /start.
  const message = await sendRichMessage(chatId, formatDay(payload, payload.today, selected), navKeyboard(payload.today, payload.today, selected));
  await store.save(chatId, message.message_id, { view: selected });
  // Удаляем прошлую карточку последней: упади отправка раньше, в чате и в
  // хранилище осталась бы рабочая старая, а не ссылка на удалённое сообщение.
  if (existing) await deleteMessage(chatId, existing.messageId).catch(() => {});
  const digestMessageId = await store.clearDigest(chatId).catch(() => null);
  if (digestMessageId) await deleteMessage(chatId, digestMessageId).catch(() => {});
  return message;
}

async function showNotifications(chatId, messageId, action, date, selected) {
  const store = dashboardStore();
  const dashboard = await store.get(chatId);
  if (!dashboard) return 'Карточка не найдена — отправьте /start';
  let subscribed = dashboard.facilities;
  if (action !== 'menu') {
    if (action === 'all') subscribed = null;
    else if (action === 'off') subscribed = [];
    else subscribed = toggleSubscription(subscribed, action);
    await store.update(chatId, { facilities: subscribed });
  }
  await editRichMessage(chatId, messageId, formatNotifications(subscribed), notificationsKeyboard(subscribed, date, selected));
  return undefined;
}

async function handleCallback(callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = String(callback.data || '');
  let toast;
  try {
    if (!chatId || !messageId) return;
    if (data === 'ack') {
      // «Ознакомлен» под сообщением об изменениях: удаляем его, чтобы чат
      // не зарастал. Telegram не даёт удалять сообщения старше 48 часов.
      await deleteMessage(chatId, messageId).catch(() => {
        toast = 'Сообщение старше 48 часов — удалите его вручную';
      });
      return;
    }
    const notifyAction = NOTIFY_ACTION_RE.exec(data);
    if (notifyAction) {
      toast = await showNotifications(chatId, messageId, notifyAction[1], notifyAction[2], notifyAction[3]);
      return;
    }
    const dayAction = DAY_ACTION_RE.exec(data);
    const facilityAction = FACILITY_ACTION_RE.exec(data);
    if (!dayAction && !facilityAction) {
      // Кнопка из карточки прошлой версии: перерисовать её нечем, зато можно
      // объяснить, что делать.
      toast = 'Кнопка устарела — отправьте /start';
      return;
    }
    const force = dayAction?.[1] === 'r';
    const payload = await getSchedule({ force });
    const date = facilityAction ? facilityAction[2] : dayAction[2];
    const selected = facilityAction ? facilityAction[1] : dayAction[3];
    // Выбор объекта запоминаем: фоновые обновления перерисовывают карточку
    // и без этого возвращали бы её к «Всем объектам».
    if (facilityAction) await dashboardStore().update(chatId, { view: selected }).catch(() => {});
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
  // Описание снято намеренно: экран «Что умеет этот бот?» занимал весь чат до
  // первого /start. Пустая строка стирает ранее заданный текст.
  const description = await tgApi('setMyDescription', { description: '' });
  const shortDescription = await tgApi('setMyShortDescription', { short_description: '' });
  res.status(200).json({ ok: true, webhook, commands, description, shortDescription });
}

module.exports = async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!secret || !process.env.TELEGRAM_BOT_TOKEN || !redisUrl || !redisToken) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }
  // Предпочтительно передавать секрет заголовком (не попадает в логи запросов);
  // query-параметр оставлен для настройки из браузера — после неё секрет стоит заменить.
  const setupToken = String(req.headers?.['x-setup-secret'] || '')
    || new URL(req.url || '/', `https://${req.headers?.host || 'localhost'}`).searchParams.get('setup') || '';
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
