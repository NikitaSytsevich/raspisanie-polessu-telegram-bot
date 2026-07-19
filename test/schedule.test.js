const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { sessionsFromInline, sessionsFromTables } = require('../lib/schedule');

test('the final session does not absorb unrelated page text', () => {
  const sessions = sessionsFromInline(
    'Понедельник 13.07.2026 10.30 – 11.15(свободно 3 дорожки) 19.15 – 20.00 Оплатить услуги в кассе',
    '2026-07-13',
  );
  assert.deepEqual(sessions, [
    { date: '2026-07-13', start: '10:30', end: '11:15', activity: 'свободно 3 дорожки' },
    { date: '2026-07-13', start: '19:15', end: '20:00', activity: '' },
  ]);
});

test('table headers with short weekday names are recognized', () => {
  const $ = cheerio.load(`<main><table>
    <tr><th>Время</th><th>Пн</th><th>Вт</th><th>Ср.</th><th>Чт</th></tr>
    <tr><td>9.15-10.00</td><td>Зал</td><td></td><td>Зал</td><td></td></tr>
  </table></main>`);
  const sessions = sessionsFromTables($, $('main'), '2026-07-13');
  assert.deepEqual(sessions.map(s => s.date), ['2026-07-13', '2026-07-15']);
});

test('weekly tables produce sessions with hours and minutes intact', () => {
  const $ = cheerio.load(`<main><table>
    <tr><th>Время</th><th>Понедельник</th><th>Вторник</th><th>Среда</th><th>Четверг</th></tr>
    <tr><td>9.15-10.00</td><td>Тренажёрный зал</td><td></td><td>Зал штанги</td><td></td></tr>
    <tr><td>18.00-19.30</td><td></td><td>Тренажёрный зал</td><td></td><td>Зал штанги</td></tr>
  </table></main>`);
  const sessions = sessionsFromTables($, $('main'), '2026-07-13');
  assert.deepEqual(sessions, [
    { date: '2026-07-13', start: '09:15', end: '10:00', activity: 'Тренажёрный зал' },
    { date: '2026-07-15', start: '09:15', end: '10:00', activity: 'Зал штанги' },
    { date: '2026-07-14', start: '18:00', end: '19:30', activity: 'Тренажёрный зал' },
    { date: '2026-07-16', start: '18:00', end: '19:30', activity: 'Зал штанги' },
  ]);
});
