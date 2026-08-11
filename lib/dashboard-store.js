const INDEX_KEY = 'polessu:schedule:dashboard-chats';
const KEY_PREFIX = 'polessu:schedule:dashboard:';
const SNAPSHOT_KEY = 'polessu:schedule:source-snapshot';
const DIGEST_PREFIX = 'polessu:schedule:digest:';
const DIGEST_DATE_KEY = 'polessu:schedule:digest-date';

function dashboardKey(chatId) {
  return `${KEY_PREFIX}${chatId}`;
}

function parseDashboard(chatId, value) {
  if (!value) return null;
  try {
    const dashboard = typeof value === 'string' ? JSON.parse(value) : value;
    const messageId = Number(dashboard?.messageId);
    if (!Number.isSafeInteger(messageId) || messageId < 1) return null;
    return {
      chatId: String(chatId),
      messageId,
      // Объект, на котором открыта карточка: фоновое обновление не должно
      // сбрасывать выбранный фильтр обратно на «Все».
      view: typeof dashboard.view === 'string' ? dashboard.view : 'all',
      // Подписка на уведомления: null — все объекты, в том числе для записей,
      // созданных до появления настроек.
      facilities: Array.isArray(dashboard.facilities)
        ? dashboard.facilities.filter(id => typeof id === 'string')
        : null,
    };
  } catch {
    return null;
  }
}

// В Redis пишем только то, что отличается от значений по умолчанию: записи
// остаются короткими, а «все объекты» выглядит одинаково у старых и новых чатов.
function serializeDashboard({ messageId, view, facilities }) {
  return JSON.stringify({
    messageId: Number(messageId),
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

  return {
    async save(chatId, messageId, patch = {}) {
      const normalizedChatId = String(chatId);
      if (!Number.isSafeInteger(Number(messageId)) || Number(messageId) < 1) throw new Error('messageId is invalid');
      // Настройки чата переживают пересоздание карточки: /start меняет только
      // id сообщения, подписка и выбранный объект остаются прежними.
      const existing = parseDashboard(normalizedChatId, await command('GET', dashboardKey(normalizedChatId)));
      await pipeline([
        ['SET', dashboardKey(normalizedChatId), serializeDashboard({ ...existing, ...patch, messageId })],
        ['SADD', INDEX_KEY, normalizedChatId],
      ]);
    },

    // Частичное обновление записи. Чата без карточки не создаёт: настраивать
    // нечего, пока пользователь не отправил /start.
    async update(chatId, patch) {
      const normalizedChatId = String(chatId);
      const existing = parseDashboard(normalizedChatId, await command('GET', dashboardKey(normalizedChatId)));
      if (!existing) return null;
      const next = { ...existing, ...patch };
      await command('SET', dashboardKey(normalizedChatId), serializeDashboard(next));
      return next;
    },

    async get(chatId) {
      const normalizedChatId = String(chatId);
      return parseDashboard(normalizedChatId, await command('GET', dashboardKey(normalizedChatId)));
    },

    async list() {
      const chatIds = await command('SMEMBERS', INDEX_KEY);
      if (!Array.isArray(chatIds) || !chatIds.length) return [];
      const values = await pipeline(chatIds.map(chatId => ['GET', dashboardKey(chatId)]));
      return values.map((value, index) => parseDashboard(chatIds[index], value)).filter(Boolean);
    },

    async remove(chatId) {
      const normalizedChatId = String(chatId);
      await pipeline([
        ['DEL', dashboardKey(normalizedChatId)],
        ['DEL', `${DIGEST_PREFIX}${normalizedChatId}`],
        ['SREM', INDEX_KEY, normalizedChatId],
      ]);
    },

    // Утренняя сводка убрана. Последняя отправленная висит в чате, поэтому
    // первый же /start возвращает её id и стирает ключи. Удалить можно только
    // сообщение моложе 48 часов — сводка приходила ежедневно, так что успеваем.
    async clearDigest(chatId) {
      const key = `${DIGEST_PREFIX}${String(chatId)}`;
      const [value] = await pipeline([['GET', key], ['DEL', key], ['DEL', DIGEST_DATE_KEY]]);
      const messageId = Number(value);
      return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
    },

    async getSnapshot() {
      const value = await command('GET', SNAPSHOT_KEY);
      if (!value) return null;
      try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
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
