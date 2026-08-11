const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardStore } = require('../lib/dashboard-store');

function json(result, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => result };
}

test('dashboard store persists message IDs and skips malformed records', async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.endsWith('/pipeline')) {
      if (body[0][0] === 'SET') return json([{ result: 'OK' }, { result: 1 }]);
      return json([{ result: '{"messageId":9}' }, { result: '{"messageId":"bad"}' }]);
    }
    if (body[0] === 'SMEMBERS') return json({ result: ['123', 'broken'] });
    return json({ result: null });
  };
  const store = createDashboardStore({ url: 'https://redis.example/', token: 'secret', fetchFn });

  await store.save(123, 9);
  assert.deepEqual(requests.at(-1).body, [
    ['SET', 'polessu:schedule:dashboard:123', '{"messageId":9}'],
    ['SADD', 'polessu:schedule:dashboard-chats', '123'],
  ]);
  assert.deepEqual(await store.list(), [{ chatId: '123', messageId: 9, view: 'all', facilities: null }]);
});

test('settings survive card recreation and unknown chats are not created by update', async () => {
  const writes = [];
  const stored = new Map([['polessu:schedule:dashboard:123', '{"messageId":9,"view":"ice_arena","facilities":["ice_arena"]}']]);
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    const run = ([cmd, key, value]) => {
      if (cmd === 'GET') return stored.get(key) ?? null;
      if (cmd === 'SET') { writes.push(value); stored.set(key, value); return 'OK'; }
      return 1;
    };
    if (url.endsWith('/pipeline')) return json(body.map(command => ({ result: run(command) })));
    return json({ result: run(body) });
  };
  const store = createDashboardStore({ url: 'https://redis.example/', token: 'secret', fetchFn });

  // /start присылает новую карточку — подписка и выбранный объект остаются.
  await store.save(123, 42);
  assert.equal(writes.at(-1), '{"messageId":42,"view":"ice_arena","facilities":["ice_arena"]}');
  // Пустой список — это «уведомления выключены», а не значение по умолчанию.
  await store.update(123, { facilities: [] });
  assert.deepEqual((await store.get(123)).facilities, []);
  assert.equal(await store.update(999, { view: 'all' }), null);
});
