const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardStore } = require('../lib/dashboard-store');

const DASHBOARDS_KEY = 'polessu:schedule:dashboards';
const SETTINGS_KEY = 'polessu:schedule:settings';
const LEGACY_INDEX_KEY = 'polessu:schedule:dashboard-chats';

function json(result, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => result };
}

// Фальшивый Redis на Map: строки, хеши и SET старой раскладки — этого хватает
// всем командам хранилища.
function fakeRedis({ strings = {}, hashes = {}, sets = {} } = {}) {
  const stored = new Map(Object.entries(strings));
  const hash = new Map(Object.entries(hashes).map(([key, value]) => [key, new Map(Object.entries(value))]));
  const set = new Map(Object.entries(sets).map(([key, value]) => [key, new Set(value)]));
  const sent = [];
  const hashOf = key => hash.get(key) || hash.set(key, new Map()).get(key);
  const run = ([cmd, key, ...args]) => {
    sent.push([cmd, key, ...args]);
    if (cmd === 'GET') return stored.get(key) ?? null;
    if (cmd === 'SET') { stored.set(key, args[0]); return 'OK'; }
    if (cmd === 'DEL') { stored.delete(key); hash.delete(key); set.delete(key); return 1; }
    if (cmd === 'HGET') return hashOf(key).get(args[0]) ?? null;
    if (cmd === 'HSET') { hashOf(key).set(args[0], args[1]); return 1; }
    if (cmd === 'HDEL') { hashOf(key).delete(args[0]); return 1; }
    // Upstash отдаёт HGETALL сырым ответом Redis — плоским списком пар.
    if (cmd === 'HGETALL') return [...hashOf(key)].flat();
    if (cmd === 'SREM') { set.get(key)?.delete(args[0]); return 1; }
    if (cmd === 'SMEMBERS') return [...(set.get(key) || [])];
    throw new Error(`fake redis: unsupported ${cmd}`);
  };
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/pipeline')) return json(body.map(command => ({ result: run(command) })));
    return json({ result: run(body) });
  };
  const store = createDashboardStore({ url: 'https://redis.example/', token: 'secret', fetchFn });
  return { stored, hashOf, sent, store };
}

test('cards and settings live in two hashes and skip malformed records', async () => {
  const { hashOf, sent, store } = fakeRedis();

  await store.save(123, 9);
  assert.deepEqual(sent.slice(-2), [
    ['HSET', DASHBOARDS_KEY, '123', '{"messageId":9}'],
    ['HSET', SETTINGS_KEY, '123', '{}'],
  ]);
  // Отдельного индекса больше нет: поля хеша карточек и есть список чатов.
  hashOf(DASHBOARDS_KEY).set('broken', '{"messageId":"bad"}');
  assert.deepEqual(await store.list(), [{ chatId: '123', messageId: 9, view: 'all', facilities: null }]);
});

test('reading every chat costs the same handful of commands whatever the audience', async () => {
  const cards = {};
  const settings = {};
  for (let chatId = 1; chatId <= 50; chatId++) {
    cards[chatId] = `{"messageId":${chatId}}`;
    settings[chatId] = '{}';
  }
  const { sent, store } = fakeRedis({ hashes: { [DASHBOARDS_KEY]: cards, [SETTINGS_KEY]: settings } });

  assert.equal((await store.list()).length, 50);
  // Прежняя раскладка тратила SMEMBERS плюс два GET на чат, то есть 104 команды
  // на этот же список. При проверке раз в пять минут расход упирался в
  // бесплатные 500K команд Upstash примерно на сороковом чате.
  assert.deepEqual(sent.map(([cmd]) => cmd), ['HGETALL', 'HGETALL', 'SMEMBERS']);
});

test('settings survive card recreation and unknown chats are not created by update', async () => {
  const { hashOf, sent, store } = fakeRedis({
    hashes: {
      [DASHBOARDS_KEY]: { 123: '{"messageId":9}' },
      [SETTINGS_KEY]: { 123: '{"view":"ice_arena","facilities":["ice_arena"]}' },
    },
  });

  // /start присылает новую карточку — подписка и выбранный объект остаются.
  const existing = await store.get(123);
  await store.save(123, 42, existing);
  assert.deepEqual(await store.get(123), { chatId: '123', messageId: 42, view: 'ice_arena', facilities: ['ice_arena'] });
  // Пустой список — это «уведомления выключены», а не значение по умолчанию.
  await store.update(123, { facilities: [] });
  assert.deepEqual((await store.get(123)).facilities, []);
  assert.equal(await store.update(999, { view: 'all' }), null);
  // Хеш настроек и хеш карточек не пересекаются: id сообщения не может быть
  // затёрт записью настроек, а значит чат не выпадет из фоновых обновлений.
  assert.ok(sent.every(([cmd, key, , value]) => cmd !== 'HSET' || key !== SETTINGS_KEY || !String(value).includes('messageId')));
  assert.equal(hashOf(DASHBOARDS_KEY).get('123'), '{"messageId":42}');
});

test('chats stored key-per-chat are moved into the hashes by the first background check', async () => {
  const { stored, hashOf, sent, store } = fakeRedis({
    strings: {
      'polessu:schedule:dashboard:123': '{"messageId":9}',
      'polessu:schedule:settings:123': '{"view":"ice_arena"}',
      // Ещё более ранняя запись: настройки лежат внутри самой карточки.
      'polessu:schedule:dashboard:456': '{"messageId":7,"facilities":["sports_pool"]}',
    },
    sets: { [LEGACY_INDEX_KEY]: ['123', '456'] },
  });

  assert.deepEqual(await store.list(), [
    { chatId: '123', messageId: 9, view: 'ice_arena', facilities: null },
    { chatId: '456', messageId: 7, view: 'all', facilities: ['sports_pool'] },
  ]);
  assert.equal(hashOf(DASHBOARDS_KEY).get('456'), '{"messageId":7}');
  assert.equal(hashOf(SETTINGS_KEY).get('456'), '{"facilities":["sports_pool"]}');
  // Перенос убирает за собой: старые ключи и индекс исчезают, и следующая
  // проверка снова стоит три команды.
  assert.equal(stored.get('polessu:schedule:dashboard:123'), undefined);
  sent.length = 0;
  assert.equal((await store.list()).length, 2);
  assert.deepEqual(sent.map(([cmd]) => cmd), ['HGETALL', 'HGETALL', 'SMEMBERS']);
});

test('a chat pressing buttons before that check is migrated on the spot', async () => {
  const { hashOf, store } = fakeRedis({
    strings: { 'polessu:schedule:dashboard:123': '{"messageId":9,"view":"small_pool","facilities":["small_pool"]}' },
    sets: { [LEGACY_INDEX_KEY]: ['123'] },
  });

  // Иначе между деплоем и первой фоновой проверкой живая карточка отвечала бы
  // «карточка не найдена — отправьте /start».
  assert.deepEqual(await store.get(123), { chatId: '123', messageId: 9, view: 'small_pool', facilities: ['small_pool'] });
  assert.equal(hashOf(DASHBOARDS_KEY).get('123'), '{"messageId":9}');
});

test('facility ids that no longer exist never reach the card', async () => {
  const { store } = fakeRedis({
    hashes: {
      [DASHBOARDS_KEY]: { 123: '{"messageId":9}' },
      [SETTINGS_KEY]: { 123: '{"view":"gym","facilities":["gym","ice_arena"]}' },
    },
  });

  // Иначе кнопки карточки унесли бы «gym» в callback_data, ни одно правило
  // маршрутизации его не приняло бы, и карточка замолчала бы навсегда.
  const dashboard = await store.get(123);
  assert.equal(dashboard.view, 'all');
  assert.deepEqual(dashboard.facilities, ['ice_arena']);
});
