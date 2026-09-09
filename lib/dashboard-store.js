const { normalizeSubscription, normalizeView } = require('./subscriptions');

// Карточки и настройки лежат двумя хешами, поле — chat_id. Чтение всех чатов
// стоит две команды вместо «SMEMBERS плюс два GET на чат», то есть расход
// Redis больше не растёт вместе с аудиторией: прежняя раскладка при проверке
// раз в пять минут упиралась в бесплатные 500K команд Upstash примерно на
// сороковом чате. Хеша два, а не один, по той же причине, что раньше было два
// ключа: /start переписывает только карточку, экран уведомлений — только
// настройки, и одновременные запросы не могут затереть чужой messageId.
const DASHBOARDS_KEY = 'polessu:schedule:dashboards';
const SETTINGS_KEY = 'polessu:schedule:settings';
const SNAPSHOT_KEY = 'polessu:schedule:source-snapshot';

// Раскладка до перехода на хеши: ключ на карточку, ключ на настройки и SET со
// списком чатов. Читается, пока индекс не опустеет: первая же фоновая проверка
// переносит записи в хеши и удаляет старые ключи. Когда в проде не останется
// таких чатов, эти три константы и ветки переноса можно убрать целиком.
const LEGACY_INDEX_KEY = 'polessu:schedule:dashboard-chats';
const LEGACY_CARD_PREFIX = 'polessu:schedule:dashboard:';
const LEGACY_SETTINGS_PREFIX = 'polessu:schedule:settings:';

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

// Настройки лежат отдельно от id карточки. У чатов, заведённых до разделения,
// они ещё внутри записи карточки — читаем их оттуда, пока первая же запись не
// разложит всё заново.
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

function serializeCard(messageId) {
  return JSON.stringify({ messageId: Number(messageId) });
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

  // Переносит чаты старой раскладки в хеши и убирает за собой старые ключи.
  // Возвращает перенесённые записи: вызывающий уже собирался их читать.
  async function migrateLegacy(chatIds, known) {
    // Чат, уже лежащий в хеше, второй раз не переносим: иначе настройки,
    // изменённые после переноса, откатились бы к старой записи.
    const fresh = chatIds.filter(chatId => !known.has(chatId));
    const values = fresh.length ? await pipeline([
      ...fresh.map(chatId => ['GET', `${LEGACY_CARD_PREFIX}${chatId}`]),
      ...fresh.map(chatId => ['GET', `${LEGACY_SETTINGS_PREFIX}${chatId}`]),
    ]) : [];
    const moved = [];
    const writes = [];
    fresh.forEach((chatId, index) => {
      const dashboard = parseDashboard(chatId, values[index], values[fresh.length + index]);
      if (!dashboard) return;
      writes.push(['HSET', DASHBOARDS_KEY, chatId, serializeCard(dashboard.messageId)]);
      writes.push(['HSET', SETTINGS_KEY, chatId, serializeSettings(dashboard)]);
      moved.push(dashboard);
    });
    for (const chatId of chatIds) {
      writes.push(['DEL', `${LEGACY_CARD_PREFIX}${chatId}`], ['DEL', `${LEGACY_SETTINGS_PREFIX}${chatId}`]);
    }
    // Индекс сносим последним: упади перенос раньше, следующая проверка найдёт
    // те же чаты на месте и повторит его целиком.
    writes.push(['DEL', LEGACY_INDEX_KEY]);
    await pipeline(writes);
    return moved;
  }

  async function readDashboard(normalizedChatId) {
    const [card, settings] = await pipeline([
      ['HGET', DASHBOARDS_KEY, normalizedChatId],
      ['HGET', SETTINGS_KEY, normalizedChatId],
    ]);
    const dashboard = parseDashboard(normalizedChatId, card, settings);
    if (dashboard) return dashboard;
    // Хвост старой раскладки: между деплоем и первой фоновой проверкой чат
    // ещё лежит по-старому, а пользователь уже жмёт кнопки — и услышал бы
    // «карточка не найдена» о живой карточке. Переносим такой чат на месте.
    const [legacyCard, legacySettings] = await pipeline([
      ['GET', `${LEGACY_CARD_PREFIX}${normalizedChatId}`],
      ['GET', `${LEGACY_SETTINGS_PREFIX}${normalizedChatId}`],
    ]);
    const legacy = parseDashboard(normalizedChatId, legacyCard, legacySettings);
    if (!legacy) return null;
    await pipeline([
      ['HSET', DASHBOARDS_KEY, normalizedChatId, serializeCard(legacy.messageId)],
      ['HSET', SETTINGS_KEY, normalizedChatId, serializeSettings(legacy)],
      ['DEL', `${LEGACY_CARD_PREFIX}${normalizedChatId}`],
      ['DEL', `${LEGACY_SETTINGS_PREFIX}${normalizedChatId}`],
      ['SREM', LEGACY_INDEX_KEY, normalizedChatId],
    ]);
    return legacy;
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
      const [cards, settings, legacyChatIds] = await pipeline([
        ['HGETALL', DASHBOARDS_KEY],
        ['HGETALL', SETTINGS_KEY],
        // Пока хвост старой раскладки не разобран, третья команда — цена
        // безопасного перехода; после него SMEMBERS отдаёт пустой список.
        ['SMEMBERS', LEGACY_INDEX_KEY],
      ]);
      const settingsByChat = new Map(hashEntries(settings));
      const dashboards = hashEntries(cards)
        .map(([chatId, card]) => parseDashboard(chatId, card, settingsByChat.get(chatId)))
        .filter(Boolean);
      if (!Array.isArray(legacyChatIds) || !legacyChatIds.length) return dashboards;
      const known = new Set(dashboards.map(dashboard => dashboard.chatId));
      return [...dashboards, ...await migrateLegacy(legacyChatIds.map(String), known)];
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
