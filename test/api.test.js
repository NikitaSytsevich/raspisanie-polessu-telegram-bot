const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret-for-tests-0123456789ab';
process.env.CHANGE_CHECK_SECRET = 'change-secret-for-tests-0123456789abc';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-redis-token';

const telegramHandler = require('../api/telegram');
const checkChangesHandler = require('../api/check-changes');

// Фальшивый Redis: понимает команды, которыми пользуется dashboard-store.
const redis = new Map();
const redisSets = new Map();
function runCommand([cmd, key, ...args]) {
  if (cmd === 'GET') return redis.get(key) ?? null;
  if (cmd === 'SET') { redis.set(key, args[0]); return 'OK'; }
  if (cmd === 'DEL') { redis.delete(key); return 1; }
  if (cmd === 'SADD') { (redisSets.get(key) || redisSets.set(key, new Set()).get(key)).add(args[0]); return 1; }
  if (cmd === 'SREM') { redisSets.get(key)?.delete(args[0]); return 1; }
  if (cmd === 'SMEMBERS') return [...(redisSets.get(key) || [])];
  throw new Error(`fake redis: unsupported ${cmd}`);
}

const telegramCalls = [];
const PAGE = `<html><body><main>
  Понедельник 13.07.2026 10.30 – 11.15 (свободно 3 дорожки) 19.15 – 20.00
</main></body></html>`;
let pageHtml = PAGE;

global.fetch = async (url, options = {}) => {
  const target = String(url);
  const ok = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer });
  if (target.startsWith('https://fake-redis.test/pipeline')) {
    return ok(JSON.parse(options.body).map(command => ({ result: runCommand(command) })));
  }
  if (target.startsWith('https://fake-redis.test')) {
    return ok({ result: runCommand(JSON.parse(options.body)) });
  }
  if (target.includes('api.telegram.org')) {
    telegramCalls.push({ method: target.split('/').pop(), params: JSON.parse(options.body) });
    return ok({ ok: true, result: { message_id: 100 + telegramCalls.length } });
  }
  if (target.includes('polessu.by')) {
    return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => new TextEncoder().encode(pageHtml).buffer };
  }
  throw new Error(`fake fetch: unexpected url ${target}`);
};

function makeRes() {
  const res = { statusCode: 0, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.body = value; return res; };
  return res;
}

test('webhook rejects wrong method and wrong secret', async () => {
  const wrongMethod = makeRes();
  await telegramHandler({ method: 'GET', url: '/api/telegram', headers: { host: 'bot.test' } }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);

  const wrongSecret = makeRes();
  await telegramHandler({ method: 'POST', url: '/api/telegram', headers: { 'x-telegram-bot-api-secret-token': 'nope' }, body: {} }, wrongSecret);
  assert.equal(wrongSecret.statusCode, 401);
});

test('start command creates the dashboard card and stores its id', async () => {
  const res = makeRes();
  await telegramHandler({
    method: 'POST',
    url: '/api/telegram',
    headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
    body: { message: { text: '/start', chat: { id: 42 } } },
  }, res);
  assert.equal(res.statusCode, 200);
  const sent = telegramCalls.find(call => call.method === 'sendRichMessage');
  assert.ok(sent, 'card message is sent');
  assert.match(sent.params.rich_message.html, /Ледовая арена/);
  assert.equal(redis.get('polessu:schedule:dashboard:42'), JSON.stringify({ messageId: 101 }));
});

test('check-changes requires the secret and reports schedule diffs', async () => {
  const unauthorized = makeRes();
  await checkChangesHandler({ method: 'POST', headers: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const auth = { authorization: `Bearer ${process.env.CHANGE_CHECK_SECRET}` };
  const first = makeRes();
  await checkChangesHandler({ method: 'POST', headers: auth }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.changed, 0);

  // Сайт публикует новый сеанс: следующая проверка обязана прислать сводку.
  pageHtml = PAGE.replace('19.15 – 20.00', '19.15 – 20.00 21.00 – 21.45');
  telegramCalls.length = 0;
  const second = makeRes();
  await checkChangesHandler({ method: 'POST', headers: auth }, second);
  assert.equal(second.statusCode, 200);
  assert.ok(second.body.changed >= 1, 'change detected');
  assert.equal(second.body.notifications, 1);
  const alert = telegramCalls.find(call => call.method === 'sendRichMessage' && !call.params.disable_notification);
  assert.match(alert.params.rich_message.html, /Расписание обновлено/);
});

test('site changes also refresh the already sent morning digest', async () => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  redis.set('polessu:schedule:digest-date', today);
  redis.set('polessu:schedule:digest:42', '555');

  pageHtml = pageHtml.replace('21.00 – 21.45', '21.00 – 21.45 22.00 – 22.45');
  telegramCalls.length = 0;
  const res = makeRes();
  await checkChangesHandler({ method: 'POST', headers: { authorization: `Bearer ${process.env.CHANGE_CHECK_SECRET}` } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.changed >= 1, 'change detected');
  assert.equal(res.body.digests, 0, 'no new digest is sent');
  assert.equal(res.body.digestsRefreshed, 1, 'existing digest is edited');
  const edited = telegramCalls.find(call => call.method === 'editMessageText' && call.params.message_id === 555);
  assert.match(edited.params.rich_message.html, /Сегодня/);
});
