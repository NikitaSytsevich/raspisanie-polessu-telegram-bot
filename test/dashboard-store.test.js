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
  assert.deepEqual(requests[0].body, [
    ['SET', 'polessu:schedule:dashboard:123', '{"messageId":9}'],
    ['SADD', 'polessu:schedule:dashboard-chats', '123'],
  ]);
  assert.deepEqual(await store.list(), [{ chatId: '123', messageId: 9 }]);
});
