const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDay, navKeyboard, sourcesKeyboard } = require('../lib/format');

const payload = {
  today: '2026-07-12',
  facilities: [{
    id: 'ice', name: 'Арена & зал', sourceUrl: 'https://example.test/?a=1&b=2', status: 'ok',
    sessions: [{ date: '2026-07-12', start: '10:00', end: '11:30', activity: '<Хоккей>' }],
  }],
};

test('day schedule is a Rich Message table and escapes source data', () => {
  const html = formatDay(payload, payload.today);
  assert.match(html, /<h3>Все объекты/);
  assert.match(html, /<table bordered striped>/);
  assert.match(html, /<th>Время<\/th><th>Что проходит<\/th>/);
  assert.match(html, /Арена &amp; зал/);
  assert.match(html, /&lt;Хоккей&gt;/);
  assert.match(html, /<b><a href="https:\/\/example\.test\/\?a=1&amp;b=2">Арена &amp; зал<\/a><\/b>/);
});

test('facility filter keeps the official source link in the normal table font', () => {
  const html = formatDay(payload, payload.today, 'ice');
  assert.match(html, /Арена &amp; зал/);
  assert.match(html, /<b><a href=/);
});

test('navigation stores only compact callback payloads', () => {
  const keyboard = navKeyboard('2026-07-12', '2026-07-12');
  for (const row of keyboard.inline_keyboard) for (const button of row) assert.ok(button.callback_data.length <= 64);
});

test('sources are separated from the schedule and return to the same view', () => {
  const keyboard = sourcesKeyboard(payload, payload.today, 'ice');
  assert.equal(keyboard.inline_keyboard[0][0].url, payload.facilities[0].sourceUrl);
  assert.equal(keyboard.inline_keyboard.at(-1)[0].callback_data, 'd:2026-07-12:ice');
});
