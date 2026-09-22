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
const redisHashes = new Map();
function hashOf(key) {
  return redisHashes.get(key) || redisHashes.set(key, new Map()).get(key);
}
function runCommand([cmd, key, ...args]) {
  if (cmd === 'GET') return redis.get(key) ?? null;
  if (cmd === 'SET') { redis.set(key, args[0]); return 'OK'; }
  if (cmd === 'DEL') { redis.delete(key); redisHashes.delete(key); return 1; }
  if (cmd === 'HGET') return hashOf(key).get(args[0]) ?? null;
  if (cmd === 'HSET') { hashOf(key).set(args[0], args[1]); return 1; }
  if (cmd === 'HDEL') { hashOf(key).delete(args[0]); return 1; }
  // Upstash отдаёт HGETALL сырым ответом Redis — плоским списком пар.
  if (cmd === 'HGETALL') return [...hashOf(key)].flat();
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
let siteDown = false;

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
    if (siteDown) throw new Error('The operation was aborted due to timeout');
    return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => new TextEncoder().encode(pageHtml).buffer };
  }
  throw new Error(`fake fetch: unexpected url ${target}`);
};

const DASHBOARDS_KEY = 'polessu:schedule:dashboards';
const SETTINGS_KEY = 'polessu:schedule:settings';

// Чат, заведённый в обход /start: нужен там, где проверяется поведение рассылки
// сразу на нескольких карточках.
function registerChat(chatId, settings) {
  hashOf(DASHBOARDS_KEY).set(String(chatId), JSON.stringify({ messageId: Number(chatId) }));
  hashOf(SETTINGS_KEY).set(String(chatId), JSON.stringify(settings));
}

function forgetChat(chatId) {
  hashOf(DASHBOARDS_KEY).delete(String(chatId));
  hashOf(SETTINGS_KEY).delete(String(chatId));
}

function cardOf(chatId) {
  return hashOf(DASHBOARDS_KEY).get(String(chatId));
}

function settingsOf(chatId) {
  return JSON.parse(hashOf(SETTINGS_KEY).get(String(chatId)));
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
  assert.equal(cardOf(42), JSON.stringify({ messageId: sent.messageId }));
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

  // Сайт публикует новый сеанс: проверка его замечает и обновляет карточку,
  // но уведомление выжидает одну проверку.
  pageHtml = PAGE.replace('19.15 – 20.00', '19.15 – 20.00 21.00 – 21.45');
  telegramCalls.length = 0;
  const second = makeRes();
  await checkChangesHandler({ method: 'POST', headers: auth }, second);
  assert.equal(second.statusCode, 200);
  assert.ok(second.body.changed >= 1, 'change detected');
  assert.equal(second.body.pending, true);
  assert.equal(second.body.notifications, 0);
  assert.ok(telegramCalls.some(call => call.method === 'editMessageText'), 'the card is refreshed at once');

  // Правка продержалась пять минут — уведомление уходит.
  telegramCalls.length = 0;
  const third = makeRes();
  await checkChangesHandler({ method: 'POST', headers: auth }, third);
  assert.equal(third.body.notifications, 1);
  assert.equal(third.body.pending, false);
  const alert = telegramCalls.find(call => call.method === 'sendRichMessage');
  assert.match(alert.params.rich_message.html, /Изменения в расписании/);
  assert.match(alert.params.rich_message.html, /➕ 21:00–21:45/);
  assert.equal(alert.params.reply_markup.inline_keyboard[0][0].callback_data, 'ack');
});

test('repeated /start recreates the card so it stays visible after history clear', async () => {
  const previousCardId = JSON.parse(cardOf(42)).messageId;
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
  assert.equal(cardOf(42), JSON.stringify({ messageId: sent.messageId }));
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

// Уведомление уходит со второй проверки подряд, видящей ту же правку.
async function runCheckTwice() {
  await runCheck();
  telegramCalls.length = 0;
  return runCheck();
}

test('ack button deletes the change alert message', async () => {
  telegramCalls.length = 0;
  await pressButton('ack');
  const deleted = telegramCalls.find(call => call.method === 'deleteMessage');
  assert.deepEqual(deleted.params, { chat_id: 42, message_id: 777 });
  assert.ok(telegramCalls.find(call => call.method === 'answerCallbackQuery'), 'callback is answered');
});

test('facility buttons choose several objects and the choice survives refreshes', async () => {
  telegramCalls.length = 0;
  await pressButton(`f:3:${TODAY}`);
  const edited = telegramCalls.find(call => call.method === 'editMessageText');
  assert.match(edited.params.rich_message.html, /<h3>⛸ 🏊 · /);
  assert.match(edited.params.rich_message.html, /Ледовая арена/);
  assert.match(edited.params.rich_message.html, /Большой бассейн/);
  assert.doesNotMatch(edited.params.rich_message.html, /Гребная база/);
  assert.deepEqual(settingsOf(42).view, ['ice_arena', 'sports_pool']);
  const row = edited.params.reply_markup.inline_keyboard[1];
  assert.deepEqual(row.filter(button => button.style === 'primary').map(button => button.text), ['✓⛸', '✓🏊']);
});

test('facility button from an older card still picks one object', async () => {
  telegramCalls.length = 0;
  const card = cardOf(42);
  await pressButton(`f:ice_arena:${TODAY}`);
  const edited = telegramCalls.find(call => call.method === 'editMessageText');
  assert.match(edited.params.rich_message.html, /<h3>⛸ Ледовая арена/);
  assert.deepEqual(settingsOf(42).view, ['ice_arena']);
  // Настройки живут отдельным ключом и запись карточки не переписывают: значит
  // параллельный /start не может остаться с затёртым messageId, а чат — молча
  // выпасть из фоновых обновлений по «message to edit not found».
  assert.equal(cardOf(42), card);
});

test('notification screen switches the subscription off and back on per facility', async () => {
  telegramCalls.length = 0;
  await pressButton(`n:menu:${TODAY}:1`);
  const menu = telegramCalls.find(call => call.method === 'editMessageText');
  assert.match(menu.params.rich_message.html, /Уведомления об изменениях/);
  // Экран открыт поверх карточки: возврат ведёт к тем же объектам и дню.
  assert.equal(menu.params.reply_markup.inline_keyboard.at(-1)[0].callback_data, `d:${TODAY}:1`);

  await pressButton(`n:off:${TODAY}:1`);
  await pressButton(`n:ice_arena:${TODAY}:1`);
  assert.deepEqual(settingsOf(42).facilities, ['ice_arena']);
});

test('each chat gets an alert built from its own subscription', async () => {
  // Второй чат подписан на другой объект: одна проверка обязана развести их по
  // разным текстам, а не разослать всем одну и ту же сводку.
  registerChat(55, { facilities: ['sports_pool'] });
  // Фикстура одна на все страницы: правка меняет расписание сразу всех объектов.
  pageHtml = pageHtml.replace('10.30 – 11.15', '10.30 – 11.15 12.00 – 12.45');
  const res = await runCheckTwice();
  assert.ok(res.body.changed >= 2, 'every facility changed');
  assert.equal(res.body.notifications, 2);

  const alerts = telegramCalls.filter(call => call.method === 'sendRichMessage');
  const ice = alerts.find(call => call.params.chat_id === '42').params.rich_message.html;
  const pool = alerts.find(call => call.params.chat_id === '55').params.rich_message.html;
  assert.match(ice, /Ледовая арена/);
  assert.doesNotMatch(ice, /Большой бассейн/);
  assert.match(pool, /Большой бассейн/);
  assert.doesNotMatch(pool, /Ледовая арена/);
  forgetChat(55);
});

test('the card follows a site change at once and keeps its chosen object', async () => {
  pageHtml = pageHtml.replace('12.00 – 12.45', '12.00 – 12.45 12.50 – 12.55');
  telegramCalls.length = 0;
  await runCheck();
  const card = telegramCalls.find(call => call.method === 'editMessageText' && call.params.chat_id === '42');
  assert.match(card.params.rich_message.html, /<h3>⛸ Ледовая арена/);
  assert.match(card.params.rich_message.html, /12:50–12:55/);
  // Ещё одна проверка, чтобы уведомление об этой правке не досталось следующему тесту.
  await runCheck();
});

test('a chat with notifications switched off gets no alerts at all', async () => {
  await pressButton(`n:off:${TODAY}:1`);
  pageHtml = pageHtml.replace('12.00 – 12.45', '12.00 – 12.45 13.00 – 13.45');
  const res = await runCheckTwice();
  assert.ok(res.body.changed >= 1, 'change detected');
  assert.equal(res.body.notifications, 0);
  assert.ok(!telegramCalls.some(call => call.method === 'sendRichMessage'), 'nothing is sent');
});

test('/start opens the card on the only facility the chat is subscribed to', async () => {
  registerChat(77, { facilities: ['sports_pool'] });
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
  assert.deepEqual(settingsOf(77), { view: ['sports_pool'], facilities: ['sports_pool'] });
  forgetChat(77);
});

test('/start opens the card on every facility the chat is subscribed to', async () => {
  registerChat(78, { facilities: ['ice_arena', 'rowing_base'] });
  telegramCalls.length = 0;
  const res = makeRes();
  await telegramHandler({
    method: 'POST',
    url: '/api/telegram',
    headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
    body: { message: { text: '/start', chat: { id: 78 } } },
  }, res);
  const sent = telegramCalls.find(call => call.method === 'sendRichMessage');
  assert.match(sent.params.rich_message.html, /<h3>⛸ 🚣 · /);
  forgetChat(78);
});

test('a site outage neither alerts anyone nor blanks the card', async () => {
  // Подписываем чат обратно на всё: иначе проверка ничего бы не показала.
  await pressButton(`n:all:${TODAY}:1`);
  siteDown = true;
  telegramCalls.length = 0;
  const down = await runCheckTwice();
  assert.equal(down.body.changed, 0);
  assert.equal(down.body.notifications, 0);
  // Кнопка в это время показывает последние удачные данные с пометкой.
  telegramCalls.length = 0;
  await pressButton(`r:${TODAY}:1`);
  const card = telegramCalls.find(call => call.method === 'editMessageText');
  assert.match(card.params.rich_message.html, /10:30–11:15/);
  assert.match(card.params.rich_message.html, /⚠️ сайт не ответил/);

  // Сайт вернулся с тем же расписанием — это тоже не новость.
  siteDown = false;
  telegramCalls.length = 0;
  const back = await runCheckTwice();
  assert.equal(back.body.changed, 0);
  assert.ok(!telegramCalls.some(call => call.method === 'sendRichMessage'), 'nothing is sent');
});

test('a chat that deleted its card still gets the alerts it subscribed to', async () => {
  registerChat(66, { facilities: ['ice_arena'] });
  hashOf(DASHBOARDS_KEY).delete('66');
  pageHtml = pageHtml.replace('13.00 – 13.45', '13.00 – 13.45 14.00 – 14.45');
  const res = await runCheckTwice();
  assert.ok(res.body.notifications >= 1);
  assert.ok(telegramCalls.some(call => call.method === 'sendRichMessage' && call.params.chat_id === '66'));
  forgetChat(66);
});

test('buttons from an older card version explain what to do instead of failing', async () => {
  telegramCalls.length = 0;
  await pressButton(`s:${TODAY}:all`);
  const answer = telegramCalls.find(call => call.method === 'answerCallbackQuery');
  assert.match(answer.params.text, /устарела/);
});
