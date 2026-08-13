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
// Дата страницы — всегда сегодняшняя: парсер отбрасывает сеансы старше недели,
// поэтому фикстура с жёстко зашитым числом однажды перестала бы что-либо давать.
const { todayIso } = require('../lib/schedule');
const TODAY = todayIso();
const [year, month, day] = TODAY.split('-');
const PAGE = `<html><body><main>
  Понедельник ${day}.${month}.${year} 10.30 – 11.15 (свободно 3 дорожки) 19.15 – 20.00
</main></body></html>`;
let pageHtml = PAGE;

let messageIdSeq = 100;

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
    // Счётчик сквозной, а не длина telegramCalls: тесты чистят массив, и ID
    // сообщений начинали бы повторяться между ними.
    const messageId = ++messageIdSeq;
    telegramCalls.push({ method: target.split('/').pop(), params: JSON.parse(options.body), messageId });
    return ok({ ok: true, result: { message_id: messageId } });
  }
  if (target.includes('polessu.by')) {
    return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => new TextEncoder().encode(pageHtml).buffer };
  }
  throw new Error(`fake fetch: unexpected url ${target}`);
};

const INDEX_KEY = 'polessu:schedule:dashboard-chats';

// Чат, заведённый в обход /start: нужен там, где проверяется поведение рассылки
// сразу на нескольких карточках.
function registerChat(chatId, settings) {
  redis.set(`polessu:schedule:dashboard:${chatId}`, JSON.stringify({ messageId: Number(chatId) }));
  redis.set(`polessu:schedule:settings:${chatId}`, JSON.stringify(settings));
  runCommand(['SADD', INDEX_KEY, String(chatId)]);
}

function forgetChat(chatId) {
  redis.delete(`polessu:schedule:dashboard:${chatId}`);
  redis.delete(`polessu:schedule:settings:${chatId}`);
  runCommand(['SREM', INDEX_KEY, String(chatId)]);
}

function settingsOf(chatId) {
  return JSON.parse(redis.get(`polessu:schedule:settings:${chatId}`));
}

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
  assert.equal(redis.get('polessu:schedule:dashboard:42'), JSON.stringify({ messageId: sent.messageId }));
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
  const alert = telegramCalls.find(call => call.method === 'sendRichMessage');
  assert.match(alert.params.rich_message.html, /Расписание обновлено/);
  assert.equal(alert.params.reply_markup.inline_keyboard[0][0].callback_data, 'ack');
});

test('repeated /start recreates the card so it stays visible after history clear', async () => {
  const previousCardId = JSON.parse(redis.get('polessu:schedule:dashboard:42')).messageId;
  telegramCalls.length = 0;
  const res = makeRes();
  await telegramHandler({
    method: 'POST',
    url: '/api/telegram',
    headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
    body: { message: { text: '/start', chat: { id: 42 } } },
  }, res);
  assert.equal(res.statusCode, 200);
  // Старая карточка (после очистки истории она невидима) удаляется,
  // вместо редактирования приходит новая, ID в хранилище заменяется.
  const deleted = telegramCalls.find(call => call.method === 'deleteMessage');
  assert.deepEqual(deleted.params, { chat_id: 42, message_id: previousCardId });
  const sent = telegramCalls.find(call => call.method === 'sendRichMessage');
  assert.ok(sent, 'new card is sent instead of editing the invisible one');
  assert.equal(redis.get('polessu:schedule:dashboard:42'), JSON.stringify({ messageId: sent.messageId }));
  // Порядок важен: сначала новая карточка, потом удаление старой — иначе
  // сбой отправки оставил бы чат вообще без карточки.
  assert.ok(
    telegramCalls.indexOf(sent) < telegramCalls.indexOf(deleted),
    'the old card is deleted only after the new one is delivered',
  );
});

async function pressButton(data) {
  const res = makeRes();
  await telegramHandler({
    method: 'POST',
    url: '/api/telegram',
    headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
    body: { callback_query: { id: 'cb', data, message: { chat: { id: 42 }, message_id: 777 } } },
  }, res);
  assert.equal(res.statusCode, 200);
  return res;
}

async function runCheck() {
  const res = makeRes();
  await checkChangesHandler({ method: 'POST', headers: { authorization: `Bearer ${process.env.CHANGE_CHECK_SECRET}` } }, res);
  assert.equal(res.statusCode, 200);
  return res;
}

test('ack button deletes the change alert message', async () => {
  telegramCalls.length = 0;
  await pressButton('ack');
  const deleted = telegramCalls.find(call => call.method === 'deleteMessage');
  assert.deepEqual(deleted.params, { chat_id: 42, message_id: 777 });
  assert.ok(telegramCalls.find(call => call.method === 'answerCallbackQuery'), 'callback is answered');
});

test('facility button remembers the chosen object for background refreshes', async () => {
  telegramCalls.length = 0;
  const card = redis.get('polessu:schedule:dashboard:42');
  await pressButton(`f:ice_arena:${TODAY}`);
  const edited = telegramCalls.find(call => call.method === 'editMessageText');
  assert.match(edited.params.rich_message.html, /<h3>⛸ Ледовая арена/);
  assert.equal(settingsOf(42).view, 'ice_arena');
  // Настройки живут отдельным ключом и запись карточки не переписывают: значит
  // параллельный /start не может остаться с затёртым messageId, а чат — молча
  // выпасть из фоновых обновлений по «message to edit not found».
  assert.equal(redis.get('polessu:schedule:dashboard:42'), card);
});

test('notification screen switches the subscription off and back on per facility', async () => {
  telegramCalls.length = 0;
  await pressButton(`n:menu:${TODAY}:ice_arena`);
  const menu = telegramCalls.find(call => call.method === 'editMessageText');
  assert.match(menu.params.rich_message.html, /Уведомления об изменениях/);
  // Экран открыт поверх карточки: возврат ведёт к тому же объекту и дню.
  assert.equal(menu.params.reply_markup.inline_keyboard.at(-1)[0].callback_data, `d:${TODAY}:ice_arena`);

  await pressButton(`n:off:${TODAY}:ice_arena`);
  await pressButton(`n:ice_arena:${TODAY}:ice_arena`);
  assert.deepEqual(settingsOf(42).facilities, ['ice_arena']);
});

test('each chat gets an alert built from its own subscription', async () => {
  // Второй чат подписан на другой объект: одна проверка обязана развести их по
  // разным текстам, а не разослать всем одну и ту же сводку.
  registerChat(55, { facilities: ['sports_pool'] });
  // Фикстура одна на все страницы: правка меняет расписание сразу всех объектов.
  pageHtml = pageHtml.replace('10.30 – 11.15', '10.30 – 11.15 12.00 – 12.45');
  telegramCalls.length = 0;
  const res = await runCheck();
  assert.ok(res.body.changed >= 2, 'every facility changed');
  assert.equal(res.body.notifications, 2);

  const alerts = telegramCalls.filter(call => call.method === 'sendRichMessage');
  const ice = alerts.find(call => call.params.chat_id === '42').params.rich_message.html;
  const pool = alerts.find(call => call.params.chat_id === '55').params.rich_message.html;
  assert.match(ice, /Ледовая арена/);
  assert.doesNotMatch(ice, /Большой бассейн/);
  assert.match(pool, /Большой бассейн/);
  assert.doesNotMatch(pool, /Ледовая арена/);
  // Карточка при этом обновляется целиком и остаётся на выбранном объекте.
  const card = telegramCalls.find(call => call.method === 'editMessageText' && call.params.chat_id === '42');
  assert.match(card.params.rich_message.html, /<h3>⛸ Ледовая арена/);
  forgetChat(55);
});

test('a chat with notifications switched off gets no alerts at all', async () => {
  await pressButton(`n:off:${TODAY}:ice_arena`);
  pageHtml = pageHtml.replace('12.00 – 12.45', '12.00 – 12.45 13.00 – 13.45');
  telegramCalls.length = 0;
  const res = await runCheck();
  assert.ok(res.body.changed >= 1, 'change detected');
  assert.equal(res.body.notifications, 0);
  assert.ok(!telegramCalls.some(call => call.method === 'sendRichMessage'), 'nothing is sent');
});

test('/start opens the card on the only facility the chat is subscribed to', async () => {
  // Запись в старом формате: настройки ещё лежат внутри карточки, отдельного
  // ключа нет — /start обязан их прочитать и разложить по новой раскладке.
  redis.set('polessu:schedule:dashboard:77', JSON.stringify({ messageId: 5, facilities: ['sports_pool'] }));
  telegramCalls.length = 0;
  const res = makeRes();
  await telegramHandler({
    method: 'POST',
    url: '/api/telegram',
    headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
    body: { message: { text: '/start', chat: { id: 77 } } },
  }, res);
  assert.equal(res.statusCode, 200);
  const sent = telegramCalls.find(call => call.method === 'sendRichMessage');
  assert.match(sent.params.rich_message.html, /<h3>🏊 Большой бассейн/);
  assert.deepEqual(settingsOf(77), { view: 'sports_pool', facilities: ['sports_pool'] });
});

test('buttons from an older card version explain what to do instead of failing', async () => {
  telegramCalls.length = 0;
  await pressButton(`s:${TODAY}:all`);
  const answer = telegramCalls.find(call => call.method === 'answerCallbackQuery');
  assert.match(answer.params.text, /устарела/);
});

test('the leftover morning digest is cleaned up once by a background check', async () => {
  redis.delete('polessu:schedule:digest-cleanup');
  redis.set('polessu:schedule:digest:42', '555');
  telegramCalls.length = 0;
  const first = await runCheck();
  assert.equal(first.body.digestsCleared, 1);
  const deleted = telegramCalls.find(call => call.method === 'deleteMessage');
  assert.deepEqual(deleted.params, { chat_id: '42', message_id: 555 });
  assert.equal(redis.get('polessu:schedule:digest:42'), undefined);

  // Разовая уборка: следующая проверка по чатам уже не ходит.
  telegramCalls.length = 0;
  const second = await runCheck();
  assert.equal(second.body.digestsCleared, 0);
  assert.ok(!telegramCalls.some(call => call.method === 'deleteMessage'), 'nothing is deleted twice');
});
