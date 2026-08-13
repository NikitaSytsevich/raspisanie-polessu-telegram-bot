const { normalizeSubscription, normalizeView } = require('./subscriptions');

const INDEX_KEY = 'polessu:schedule:dashboard-chats';
const KEY_PREFIX = 'polessu:schedule:dashboard:';
const SETTINGS_PREFIX = 'polessu:schedule:settings:';
const SNAPSHOT_KEY = 'polessu:schedule:source-snapshot';
const DIGEST_PREFIX = 'polessu:schedule:digest:';
const DIGEST_DATE_KEY = 'polessu:schedule:digest-date';
const DIGEST_CLEANUP_KEY = 'polessu:schedule:digest-cleanup';

function dashboardKey(chatId) {
  return `${KEY_PREFIX}${chatId}`;
}

function settingsKey(chatId) {
  return `${SETTINGS_PREFIX}${chatId}`;
}

function parseJson(value) {
  if (!value) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}

// Настройки лежат отдельным ключом от id карточки. /start переписывает только
// карточку, экран уведомлений — только настройки, поэтому одновременные запросы
// физически не могут затереть чужой messageId: карточка, потерявшая его,
// оказалась бы «сообщением, которого нет», и чат вылетел бы из рассылки молча.
// У чатов, заведённых до разделения, настройки ещё лежат внутри записи
// карточки — читаем их оттуда, пока первая же запись не разложит ключи заново.
function parseSettings(value, legacy) {
  const source = parseJson(value) || legacy || {};
  return {
    view: normalizeView(source.view),
    // Подписку прогоняем через ту же нормализацию, что и переключатели: id
    // исчезнувшего объекта не должен доживать до кнопок карточки.
    facilities: Array.isArray(source.facilities) ? normalizeSubscription(source.facilities) : null,
  };
}

function parseDashboard(chatId, value, settingsValue) {
  const card = parseJson(value);
  const messageId = Number(card?.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return null;
  return { chatId: String(chatId), messageId, ...parseSettings(settingsValue, card) };
}

// В Redis пишем только то, что отличается от значений по умолчанию: записи
// остаются короткими, а «все объекты» выглядит одинаково у старых и новых чатов.
function serializeSettings({ view, facilities }) {
  return JSON.stringify({
    ...(view && view !== 'all' ? { view } : {}),
    ...(facilities ? { facilities } : {}),
  });
}

function createDashboardStore({ url, token, fetchFn = fetch }) {
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  const endpoint = url.replace(/\/$/, '');

  async function command(...args) {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) throw new Error(json.error || `Upstash Redis HTTP ${response.status}`);
    return json.result;
  }

  async function pipeline(commands) {
    const response = await fetchFn(`${endpoint}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    const json = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(json)) throw new Error(`Upstash Redis HTTP ${response.status}`);
    const error = json.find(item => item?.error)?.error;
    if (error) throw new Error(error);
    return json.map(item => item.result);
  }

  async function readDashboard(normalizedChatId) {
    const [card, settings] = await pipeline([
      ['GET', dashboardKey(normalizedChatId)],
      ['GET', settingsKey(normalizedChatId)],
    ]);
    return parseDashboard(normalizedChatId, card, settings);
  }

  return {
    // settings передаёт вызывающий: он уже прочитал запись, и повторный GET
    // здесь только добавил бы круг до Redis на самом частом пути — /start.
    async save(chatId, messageId, settings) {
      const normalizedChatId = String(chatId);
      if (!Number.isSafeInteger(Number(messageId)) || Number(messageId) < 1) throw new Error('messageId is invalid');
      await pipeline([
        ['SET', dashboardKey(normalizedChatId), JSON.stringify({ messageId: Number(messageId) })],
        ['SET', settingsKey(normalizedChatId), serializeSettings(settings || {})],
        ['SADD', INDEX_KEY, normalizedChatId],
      ]);
    },

    // Частичное обновление настроек. Чата без карточки не создаёт: настраивать
    // нечего, пока пользователь не отправил /start.
    async update(chatId, patch) {
      const normalizedChatId = String(chatId);
      const existing = await readDashboard(normalizedChatId);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      await command('SET', settingsKey(normalizedChatId), serializeSettings(next));
      return next;
    },

    async get(chatId) {
      return readDashboard(String(chatId));
    },

    async list() {
      const chatIds = await command('SMEMBERS', INDEX_KEY);
      if (!Array.isArray(chatIds) || !chatIds.length) return [];
      const values = await pipeline([
        ...chatIds.map(chatId => ['GET', dashboardKey(chatId)]),
        ...chatIds.map(chatId => ['GET', settingsKey(chatId)]),
      ]);
      return chatIds
        .map((chatId, index) => parseDashboard(chatId, values[index], values[chatIds.length + index]))
        .filter(Boolean);
    },

    async remove(chatId) {
      const normalizedChatId = String(chatId);
      await pipeline([
        ['DEL', dashboardKey(normalizedChatId)],
        ['DEL', settingsKey(normalizedChatId)],
        ['DEL', `${DIGEST_PREFIX}${normalizedChatId}`],
        ['SREM', INDEX_KEY, normalizedChatId],
      ]);
    },

    // Утренняя сводка убрана, но последняя отправленная висит в чатах. Telegram
    // разрешает удалять сообщения моложе 48 часов, поэтому уборку делает первая
    // же фоновая проверка — она приходит через десять минут и доходит до всех
    // чатов сразу. Ждать /start нельзя: до команды пользователь может не дойти
    // неделю, и сводка останется висеть навсегда.
    async digestCleanupPending() {
      return !(await command('GET', DIGEST_CLEANUP_KEY));
    },

    async takeDigestMessageId(chatId) {
      const key = `${DIGEST_PREFIX}${String(chatId)}`;
      const [value] = await pipeline([['GET', key], ['DEL', key]]);
      const messageId = Number(value);
      return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
    },

    // Флаг ставится один раз: следующая проверка уже не пойдёт по чатам.
    async finishDigestCleanup() {
      await pipeline([['SET', DIGEST_CLEANUP_KEY, '1'], ['DEL', DIGEST_DATE_KEY]]);
    },

    async getSnapshot() {
      const value = await command('GET', SNAPSHOT_KEY);
      if (!value) return null;
      return parseJson(value);
    },

    async saveSnapshot(snapshot) {
      await command('SET', SNAPSHOT_KEY, JSON.stringify(snapshot));
    },
  };
}

function dashboardStore() {
  return createDashboardStore({
    // Vercel Marketplace names these KV_REST_API_*, while a directly connected
    // Upstash database uses UPSTASH_REDIS_REST_*. Support both setups.
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  });
}

module.exports = { createDashboardStore, dashboardStore };
