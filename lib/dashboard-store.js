const { normalizeSubscription, normalizeView } = require('./subscriptions');

// Карточки и настройки лежат двумя хешами, поле — chat_id. Чтение всех чатов
// стоит две команды вместо «SMEMBERS плюс два GET на чат», то есть расход
// Redis не растёт вместе с аудиторией: раскладка с ключом на чат при проверке
// раз в пять минут упиралась в бесплатные 500K команд Upstash примерно на
// сороковом чате. Хеша два, а не один, по той же причине, что раньше было два
// ключа: /start переписывает только карточку, экран уведомлений — только
// настройки, и одновременные запросы не могут затереть чужой messageId.
const DASHBOARDS_KEY = 'polessu:schedule:dashboards';
const SETTINGS_KEY = 'polessu:schedule:settings';
const SNAPSHOT_KEY = 'polessu:schedule:source-snapshot';

function parseJson(value) {
  if (!value) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}

// Upstash отдаёт HGETALL сырым ответом Redis — плоским списком «поле, значение»;
// в объект его собирает клиентский SDK, которого здесь нет. Принимаем обе формы:
// ошибка в этой догадке стоила бы разом всех зарегистрированных чатов.
function hashEntries(result) {
  if (Array.isArray(result)) {
    const entries = [];
    for (let i = 0; i + 1 < result.length; i += 2) entries.push([String(result[i]), result[i + 1]]);
    return entries;
  }
  return result && typeof result === 'object' ? Object.entries(result) : [];
}

// Настройки лежат отдельно от id карточки: запись карточки не содержит ничего,
// кроме messageId.
function parseSettings(value) {
  const source = parseJson(value) || {};
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
  return { chatId: String(chatId), messageId, ...parseSettings(settingsValue) };
}

function serializeCard(messageId) {
  return JSON.stringify({ messageId: Number(messageId) });
}

// В Redis пишем только то, что отличается от значений по умолчанию: записи
// остаются короткими, а «все объекты» не превращается в отдельное значение.
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
      ['HGET', DASHBOARDS_KEY, normalizedChatId],
      ['HGET', SETTINGS_KEY, normalizedChatId],
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
        ['HSET', DASHBOARDS_KEY, normalizedChatId, serializeCard(messageId)],
        ['HSET', SETTINGS_KEY, normalizedChatId, serializeSettings(settings || {})],
      ]);
    },

    // Частичное обновление настроек. Чата без карточки не создаёт: настраивать
    // нечего, пока пользователь не отправил /start.
    async update(chatId, patch) {
      const normalizedChatId = String(chatId);
      const existing = await readDashboard(normalizedChatId);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      await command('HSET', SETTINGS_KEY, normalizedChatId, serializeSettings(next));
      return next;
    },

    async get(chatId) {
      return readDashboard(String(chatId));
    },

    async list() {
      const [cards, settings] = await pipeline([
        ['HGETALL', DASHBOARDS_KEY],
        ['HGETALL', SETTINGS_KEY],
      ]);
      const settingsByChat = new Map(hashEntries(settings));
      return hashEntries(cards)
        .map(([chatId, card]) => parseDashboard(chatId, card, settingsByChat.get(chatId)))
        .filter(Boolean);
    },

    async remove(chatId) {
      const normalizedChatId = String(chatId);
      await pipeline([
        ['HDEL', DASHBOARDS_KEY, normalizedChatId],
        ['HDEL', SETTINGS_KEY, normalizedChatId],
      ]);
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
