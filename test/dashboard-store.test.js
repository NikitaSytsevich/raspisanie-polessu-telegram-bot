const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardStore } = require('../lib/dashboard-store');

function json(result, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => result };
}

// Фальшивый Redis на Map: этого хватает всем командам хранилища.
function fakeRedis(entries = []) {
  const stored = new Map(entries);
  const writes = [];
  const run = ([cmd, key, value]) => {
    if (cmd === 'GET') return stored.get(key) ?? null;
    if (cmd === 'SET') { writes.push([key, value]); stored.set(key, value); return 'OK'; }
    if (cmd === 'DEL') { stored.delete(key); return 1; }
    return 1;
  };
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/pipeline')) return json(body.map(command => ({ result: run(command) })));
    return json({ result: run(body) });
  };
  return { stored, writes, fetchFn };
}

test('dashboard store persists message IDs and skips malformed records', async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.endsWith('/pipeline')) {
      if (body[0][0] === 'SET') return json([{ result: 'OK' }, { result: 'OK' }, { result: 1 }]);
      // Две карточки, затем две записи настроек — обе пустые.
      return json([{ result: '{"messageId":9}' }, { result: '{"messageId":"bad"}' }, { result: null }, { result: null }]);
    }
    if (body[0] === 'SMEMBERS') return json({ result: ['123', 'broken'] });
    return json({ result: null });
  };
  const store = createDashboardStore({ url: 'https://redis.example/', token: 'secret', fetchFn });

  await store.save(123, 9);
  assert.deepEqual(requests.at(-1).body, [
    ['SET', 'polessu:schedule:dashboard:123', '{"messageId":9}'],
    ['SET', 'polessu:schedule:settings:123', '{}'],
    ['SADD', 'polessu:schedule:dashboard-chats', '123'],
  ]);
  assert.deepEqual(await store.list(), [{ chatId: '123', messageId: 9, view: 'all', facilities: null }]);
});

test('settings survive card recreation and unknown chats are not created by update', async () => {
  const { stored, writes, fetchFn } = fakeRedis([
    ['polessu:schedule:dashboard:123', '{"messageId":9}'],
    ['polessu:schedule:settings:123', '{"view":"ice_arena","facilities":["ice_arena"]}'],
  ]);
  const store = createDashboardStore({ url: 'https://redis.example/', token: 'secret', fetchFn });

  // /start присылает новую карточку — подписка и выбранный объект остаются.
  const existing = await store.get(123);
  await store.save(123, 42, existing);
  assert.deepEqual(await store.get(123), { chatId: '123', messageId: 42, view: 'ice_arena', facilities: ['ice_arena'] });
  // Пустой список — это «уведомления выключены», а не значение по умолчанию.
  await store.update(123, { facilities: [] });
  assert.deepEqual((await store.get(123)).facilities, []);
  assert.equal(await store.update(999, { view: 'all' }), null);
  // Ключ настроек и ключ карточки не пересекаются: id сообщения не может быть
  // затёрт записью настроек, а значит чат не выпадет из фоновых обновлений.
  assert.ok(writes.every(([key, value]) => !key.startsWith('polessu:schedule:settings:') || !value.includes('messageId')));
  assert.equal(stored.get('polessu:schedule:dashboard:123'), '{"messageId":42}');
});

test('settings written before the keys were split are still read', async () => {
  const { fetchFn } = fakeRedis([
    ['polessu:schedule:dashboard:123', '{"messageId":9,"view":"small_pool","facilities":["small_pool"]}'],
  ]);
  const store = createDashboardStore({ url: 'https://redis.example/', token: 'secret', fetchFn });

  assert.deepEqual(await store.get(123), { chatId: '123', messageId: 9, view: 'small_pool', facilities: ['small_pool'] });
});

test('facility ids that no longer exist never reach the card', async () => {
  const { fetchFn } = fakeRedis([
    ['polessu:schedule:dashboard:123', '{"messageId":9}'],
    ['polessu:schedule:settings:123', '{"view":"gym","facilities":["gym","ice_arena"]}'],
  ]);
  const store = createDashboardStore({ url: 'https://redis.example/', token: 'secret', fetchFn });

  // Иначе кнопки карточки унесли бы «gym» в callback_data, ни одно правило
  // маршрутизации его не приняло бы, и карточка замолчала бы навсегда.
  const dashboard = await store.get(123);
  assert.equal(dashboard.view, 'all');
  assert.deepEqual(dashboard.facilities, ['ice_arena']);
});
