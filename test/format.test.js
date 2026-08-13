const test = require('node:test');
const assert = require('node:assert/strict');
const { cardView, formatDay, formatNotifications, navKeyboard, notificationsKeyboard } = require('../lib/format');
const { toggleSubscription } = require('../lib/subscriptions');

const payload = {
  today: '2026-07-12',
  facilities: [{
    id: 'ice', name: 'Арена & зал', sourceUrl: 'https://example.test/?a=1&b=2', status: 'ok',
    sessions: [{ date: '2026-07-12', start: '10:00', end: '11:30', activity: '<Хоккей>' }],
  }],
};

test('day schedule uses compact session lines instead of tables and escapes source data', () => {
  const html = formatDay(payload, payload.today);
  assert.match(html, /<h3>Все объекты/);
  // Таблицы Rich Messages на iOS рендерятся с наложением рядов — их быть не должно.
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<blockquote><b>10:00–11:30<\/b> · &lt;Хоккей&gt;<\/blockquote>/);
  assert.match(html, /<b><a href="https:\/\/example\.test\/\?a=1&amp;b=2">Арена &amp; зал<\/a><\/b>/);
  assert.match(html, /<footer>Обновлено <tg-time unix="\d+" format="dt">[\d.]+, [\d:]+<\/tg-time><\/footer>/);
});

test('facility filter keeps the official source link on the facility name', () => {
  const html = formatDay(payload, payload.today, 'ice');
  assert.match(html, /Арена &amp; зал/);
  assert.match(html, /<b><a href=/);
});

test('navigation fits three rows and stores only compact callback payloads', () => {
  const keyboard = navKeyboard('2026-07-12', '2026-07-12', 'ice_arena');
  assert.equal(keyboard.inline_keyboard.length, 3);
  // Даты, объекты, настройки: по одному вопросу на ряд, объекты — одной строкой.
  assert.equal(keyboard.inline_keyboard[0].length, 3);
  assert.equal(keyboard.inline_keyboard[1].length, 5);
  assert.equal(keyboard.inline_keyboard[1][1].text, '• ⛸');
  assert.deepEqual(keyboard.inline_keyboard[2].map(button => button.callback_data), [
    'n:menu:2026-07-12:ice_arena',
    'r:2026-07-12:ice_arena',
  ]);
  for (const row of keyboard.inline_keyboard) for (const button of row) assert.ok(button.callback_data.length <= 64);
});

test('background refresh keeps the facility the chat is looking at', () => {
  const { html, replyMarkup } = cardView(payload, { view: 'ice' });
  assert.match(html, /<h3>Арена &amp; зал/);
  assert.equal(replyMarkup.inline_keyboard[1][0].text, 'Все');
});

test('notification screen shows the current subscription and offers one switch', () => {
  const all = notificationsKeyboard(null, '2026-07-12', 'all');
  assert.match(formatNotifications(null), /сообщаю обо всех объектах/);
  assert.equal(all.inline_keyboard[0][0].text, '✅ ⛸ Ледовая арена');
  assert.equal(all.inline_keyboard.at(-2)[0].text, '🔕 Выключить все');
  assert.equal(all.inline_keyboard.at(-1)[0].callback_data, 'd:2026-07-12:all');

  const single = notificationsKeyboard(['ice_arena'], '2026-07-12', 'all');
  assert.match(formatNotifications(['ice_arena']), /Сейчас: ⛸ Ледовая арена\./);
  assert.equal(single.inline_keyboard[1][0].text, '⬜️ 🏊 Большой бассейн');

  const off = notificationsKeyboard([], '2026-07-12', 'all');
  assert.match(formatNotifications([]), /уведомления выключены/);
  assert.equal(off.inline_keyboard.at(-2)[0].text, '🔔 Включить все');

  // Здесь самые длинные payload'ы бота: два id объекта плюс дата. За 64 байта
  // Telegram отказывается рисовать клавиатуру целиком.
  const longest = notificationsKeyboard(null, '2026-07-12', 'rowing_base');
  for (const row of longest.inline_keyboard) for (const button of row) assert.ok(button.callback_data.length <= 64);
});

test('toggling every facility back on collapses the subscription to “all”', () => {
  const withoutIce = toggleSubscription(null, 'ice_arena');
  assert.deepEqual(withoutIce, ['sports_pool', 'small_pool', 'rowing_base']);
  assert.equal(toggleSubscription(withoutIce, 'ice_arena'), null);
});
