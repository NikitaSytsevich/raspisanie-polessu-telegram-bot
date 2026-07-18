const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDay, formatMorningDigest, navKeyboard, sourcesKeyboard } = require('../lib/format');

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

test('morning digest is one line per facility with correct plurals', () => {
  const digest = formatMorningDigest({
    today: '2026-07-12',
    facilities: [
      { id: 'ice_arena', name: 'Ледовая арена', sourceUrl: 'https://example.test/ice', status: 'ok',
        sessions: [
          { date: '2026-07-12', start: '14:00', end: '14:45', activity: '' },
          { date: '2026-07-12', start: '18:30', end: '19:15', activity: '' },
          { date: '2026-07-13', start: '10:00', end: '11:00', activity: '' },
        ] },
      { id: 'sports_pool', name: 'Большой бассейн', sourceUrl: 'https://example.test/pool', status: 'ok',
        sessions: [{ date: '2026-07-12', start: '09:15', end: '10:00', activity: '' }] },
      { id: 'rowing_base', name: 'Гребная база', sourceUrl: 'https://example.test/row', status: 'closed', notice: 'каникулы', sessions: [] },
    ],
  });
  assert.match(digest, /<h3>☀️ Сегодня · вс, 12 июля<\/h3>/);
  // Сеансы чужой даты не попадают в сводку, склонения корректны.
  assert.match(digest, /Ледовая арена<\/b> — 2 сеанса, 14:00–19:15/);
  assert.match(digest, /Большой бассейн<\/b> — 1 сеанс, 09:15–10:00/);
  assert.match(digest, /Гребная база<\/b> — закрыто/);
  assert.doesNotMatch(digest, /10:00–11:00/);
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
