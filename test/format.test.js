const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDay, formatWeek, navKeyboard } = require('../lib/format');

const payload = {
  today: '2026-07-12',
  facilities: [{
    id: 'ice', name: 'Арена & зал', sourceUrl: 'https://example.test/?a=1&b=2', status: 'ok',
    sessions: [{ date: '2026-07-12', start: '10:00', end: '11:30', activity: '<Хоккей>' }],
  }],
};

test('day schedule is a Rich Message table and escapes source data', () => {
  const html = formatDay(payload, payload.today);
  assert.match(html, /<h3>Расписание/);
  assert.match(html, /<table bordered striped>/);
  assert.match(html, /<th>Время<\/th><th>Что проходит<\/th>/);
  assert.match(html, /Арена &amp; зал/);
  assert.match(html, /&lt;Хоккей&gt;/);
  assert.match(html, /a=1&amp;b=2/);
});

test('week uses collapsible day sections', () => {
  const html = formatWeek(payload);
  assert.match(html, /<details open>/);
  assert.match(html, /<details>/);
});

test('navigation stores only compact callback payloads', () => {
  const keyboard = navKeyboard('2026-07-12', '2026-07-12');
  for (const row of keyboard.inline_keyboard) for (const button of row) assert.ok(button.callback_data.length <= 64);
});
