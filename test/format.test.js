const test = require('node:test');
const assert = require('node:assert/strict');
const { cardView, formatDay, formatNotifications, navKeyboard, notificationsKeyboard } = require('../lib/format');
const { decodeView, encodeView, toggleSubscription, toggleView } = require('../lib/subscriptions');

const payload = {
  today: '2026-07-12',
  facilities: [{
    id: 'ice_arena', name: 'Арена & зал', sourceUrl: 'https://example.test/?a=1&b=2', status: 'ok',
    sessions: [{ date: '2026-07-12', start: '10:00', end: '11:30', activity: '<Хоккей>' }],
  }, {
    id: 'sports_pool', name: 'Бассейн', sourceUrl: 'https://example.test/pool', status: 'ok',
    sessions: [{ date: '2026-07-12', start: '09:15', end: '10:00', activity: 'свободно 8 дорожек' }],
  }, {
    id: 'rowing_base', name: 'Гребная база', sourceUrl: 'https://example.test/rowing', status: 'ok', sessions: [],
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

test('a day the page closed with a reason shows the reason, not an empty day', () => {
  const closed = {
    ...payload,
    facilities: [{
      id: 'sports_pool', name: 'Бассейн', sourceUrl: 'https://example.test/pool', status: 'ok',
      sessions: [], dayNotes: [{ date: '2026-07-12', note: 'Санитарный день' }],
    }],
  };
  const html = formatDay(closed, closed.today);
  assert.match(html, /Бассейн<\/a><\/b> — ⛔ Санитарный день<\/p>/);
  assert.doesNotMatch(html, /сеансов на эту дату нет/);
  assert.match(formatDay(closed, '2026-07-13'), /сеансов на эту дату нет/);
});

test('facility filter keeps the official source link on the facility name', () => {
  const html = formatDay(payload, payload.today, ['ice_arena']);
  assert.match(html, /<h3>⛸ Арена &amp; зал · /);
  assert.match(html, /<b><a href=/);
  assert.doesNotMatch(html, /Бассейн/);
});

test('several chosen facilities share the card and are titled by their emoji', () => {
  const html = formatDay(payload, payload.today, ['ice_arena', 'sports_pool']);
  assert.match(html, /<h3>⛸ 🏊 · /);
  assert.match(html, /Арена &amp; зал/);
  assert.match(html, /свободно 8 дорожек/);
  // Невыбранный объект в карточку не попадает.
  assert.doesNotMatch(html, /Гребная база/);
});

test('facility buttons are tags: the first pick narrows, the next ones add and remove', () => {
  // Из «Все» первое нажатие оставляет один объект — как раньше.
  assert.deepEqual(toggleView(null, 'sports_pool'), ['sports_pool']);
  // Дальше метки добавляются и снимаются, порядок — как в FACILITIES.
  assert.deepEqual(toggleView(['sports_pool'], 'ice_arena'), ['ice_arena', 'sports_pool']);
  assert.deepEqual(toggleView(['ice_arena', 'sports_pool'], 'ice_arena'), ['sports_pool']);
  // Снятая последняя метка и набор из всех объектов — это снова «Все».
  assert.equal(toggleView(['sports_pool'], 'sports_pool'), null);
  assert.equal(toggleView(['ice_arena', 'sports_pool', 'small_pool'], 'rowing_base'), null);
});

test('the chosen set travels as a one-digit mask and old tokens still decode', () => {
  assert.equal(encodeView(null), '0');
  assert.equal(encodeView(['ice_arena', 'sports_pool']), '3');
  assert.deepEqual(decodeView('3'), ['ice_arena', 'sports_pool']);
  assert.deepEqual(decodeView('8'), ['rowing_base']);
  assert.equal(decodeView('0'), null);
  // Полная маска — те же «Все».
  assert.equal(decodeView('f'), null);
  // Кнопки прошлой версии: «all» и id одного объекта.
  assert.equal(decodeView('all'), null);
  assert.deepEqual(decodeView('ice_arena'), ['ice_arena']);
});

test('navigation fits three rows and stores only compact callback payloads', () => {
  const keyboard = navKeyboard('2026-07-12', '2026-07-12', ['ice_arena']);
  assert.equal(keyboard.inline_keyboard.length, 3);
  // Даты, объекты, настройки: по одному вопросу на ряд, объекты — одной строкой.
  assert.equal(keyboard.inline_keyboard[0].length, 3);
  assert.equal(keyboard.inline_keyboard[1].length, 5);
  assert.deepEqual(keyboard.inline_keyboard[2].map(button => button.callback_data), [
    'n:menu:2026-07-12:1',
    'r:2026-07-12:1',
  ]);
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) assert.ok(button.disabled || button.callback_data.length <= 64);
  }
});

test('chosen facilities are highlighted and each button carries the resulting set', () => {
  const [, row] = navKeyboard('2026-07-12', '2026-07-12', ['ice_arena', 'sports_pool']).inline_keyboard;
  // Выбранные подсвечены и отмечены галочкой — она читается и без цвета.
  assert.deepEqual(row[1], { text: '✓⛸', callback_data: 'f:2:2026-07-12', style: 'primary' });
  assert.deepEqual(row[2], { text: '✓🏊', callback_data: 'f:1:2026-07-12', style: 'primary' });
  // Невыбранный добавляется к набору.
  assert.deepEqual(row[3], { text: '🌊', callback_data: 'f:7:2026-07-12' });
  // «Все» сбрасывает выбор.
  assert.deepEqual(row[0], { text: 'Все', callback_data: 'f:0:2026-07-12' });
});

test('buttons that would redraw the same card come back disabled', () => {
  const today = navKeyboard('2026-07-12', '2026-07-12', null);
  // «Сегодня» на сегодняшней дате и «Все» при всех объектах нажимать не за чем:
  // Telegram по выключенной кнопке не пришлёт callback, и лишний
  // editMessageText не уйдёт.
  assert.deepEqual(today.inline_keyboard[0][1], { text: 'Сегодня', disabled: {} });
  assert.deepEqual(today.inline_keyboard[1][0], { text: '• Все', disabled: {} });
  // disabled — это тип кнопки: callback_data рядом с ним Telegram не примет.
  assert.equal(today.inline_keyboard[1][0].callback_data, undefined);
  // Из «Все» объект выбирается одним нажатием.
  assert.equal(today.inline_keyboard[1][2].callback_data, 'f:2:2026-07-12');

  // На другой дате «Сегодня» снова работает и помнит выбранные объекты.
  const other = navKeyboard('2026-07-13', '2026-07-12', ['ice_arena']);
  assert.equal(other.inline_keyboard[0][1].callback_data, 'd:2026-07-12:1');
  // Единственная метка снимается и возвращает «Все».
  assert.equal(other.inline_keyboard[1][1].callback_data, 'f:0:2026-07-13');
});

test('background refresh keeps the facilities the chat is looking at', () => {
  const { html, replyMarkup } = cardView(payload, { view: ['ice_arena'] });
  assert.match(html, /<h3>⛸ Арена &amp; зал/);
  assert.equal(replyMarkup.inline_keyboard[1][0].text, 'Все');
});

test('a facility shown from its last good read says so and when it was read', () => {
  const stale = {
    ...payload,
    facilities: [{ ...payload.facilities[0], stale: true, checkedAt: '2026-07-12T11:05:00Z' }],
  };
  const html = formatDay(stale, stale.today);
  assert.match(html, /⚠️ сайт не ответил, данные на 12\.07, 14:05/);
  // Сеансы при этом остаются в карточке.
  assert.match(html, /10:00–11:30/);
});

test('notification screen shows the current subscription and offers one switch', () => {
  const all = notificationsKeyboard(null, '2026-07-12', null);
  assert.match(formatNotifications(null), /сообщаю обо всех объектах/);
  assert.equal(all.inline_keyboard[0][0].text, '🔔 ⛸ Ледовая арена');
  assert.equal(all.inline_keyboard[0][0].style, 'primary');
  assert.equal(all.inline_keyboard.at(-2)[0].text, 'Выключить все');
  assert.equal(all.inline_keyboard.at(-1)[0].callback_data, 'd:2026-07-12:0');

  const single = notificationsKeyboard(['ice_arena'], '2026-07-12', null);
  assert.match(formatNotifications(['ice_arena']), /Сейчас: ⛸ Ледовая арена\./);
  assert.equal(single.inline_keyboard[1][0].text, '🔕 🏊 Большой бассейн');
  assert.equal(single.inline_keyboard[1][0].style, undefined);

  const off = notificationsKeyboard([], '2026-07-12', null);
  assert.match(formatNotifications([]), /уведомления выключены/);
  assert.equal(off.inline_keyboard.at(-2)[0].text, 'Включить все');

  // Здесь самые длинные payload'ы бота: id объекта, дата и маска. За 64 байта
  // Telegram отказывается рисовать клавиатуру целиком.
  const longest = notificationsKeyboard(null, '2026-07-12', ['ice_arena', 'sports_pool', 'rowing_base']);
  for (const row of longest.inline_keyboard) for (const button of row) assert.ok(button.callback_data.length <= 64);
  // Клавиатура уведомлений выключенных кнопок не содержит: каждая что-то меняет.
  assert.ok(longest.inline_keyboard.every(row => row.every(button => !button.disabled)));
});

test('toggling every facility back on collapses the subscription to “all”', () => {
  const withoutIce = toggleSubscription(null, 'ice_arena');
  assert.deepEqual(withoutIce, ['sports_pool', 'small_pool', 'rowing_base']);
  assert.equal(toggleSubscription(withoutIce, 'ice_arena'), null);
});
