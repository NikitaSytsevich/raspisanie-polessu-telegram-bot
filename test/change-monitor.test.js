const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { sessionsFromTables } = require('../lib/schedule');
const { scheduleSnapshot, diffSchedules, formatChangeAlert } = require('../lib/change-monitor');

const facility = sessions => ({ id: 'pool', name: 'Бассейн', sourceUrl: 'https://example.test/pool', status: 'ok', sessions });

test('change monitor ignores unstable generated time and finds only schedule changes', () => {
  const previous = scheduleSnapshot({ generatedAt: 'one', facilities: [facility([{ date: '2026-07-16', start: '10:00', end: '11:00', activity: '' }])] });
  const same = scheduleSnapshot({ generatedAt: 'two', facilities: [facility([{ date: '2026-07-16', start: '10:00', end: '11:00', activity: '' }])] });
  assert.deepEqual(diffSchedules(previous, same), []);

  const next = scheduleSnapshot({ facilities: [facility([{ date: '2026-07-16', start: '11:30', end: '12:30', activity: '3 дорожки' }])] });
  const changes = diffSchedules(previous, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].added[0].start, '11:30');
  assert.equal(changes[0].removed[0].start, '10:00');
  assert.match(formatChangeAlert(changes), /Расписание обновлено/);
  assert.match(formatChangeAlert(changes), /➕/);
});

test('snapshot keeps the current date without treating its change as a schedule change', () => {
  const sessions = [{ date: '2026-07-16', start: '10:00', end: '11:00', activity: '' }];
  const previous = scheduleSnapshot({ today: '2026-07-16', facilities: [facility(sessions)] });
  const next = scheduleSnapshot({ today: '2026-07-17', facilities: [facility(sessions)] });
  assert.equal(previous.today, '2026-07-16');
  assert.equal(next.today, '2026-07-17');
  // Смена даты сама по себе не является изменением расписания: она включает
  // утреннее обновление карточек, но не рассылку сводки об изменениях.
  assert.deepEqual(diffSchedules(previous, next), []);
});

test('sessions that slipped into the past are not reported as removed', () => {
  // Страница объекта не изменилась, но парсер держит окно «неделя назад»,
  // поэтому старые сеансы уходят из снимка сами. Это не новость для рассылки.
  const sessions = [
    { date: '2026-07-16', start: '10:00', end: '11:00', activity: '' },
    { date: '2026-07-24', start: '10:00', end: '11:00', activity: '' },
  ];
  const previous = scheduleSnapshot({ today: '2026-07-16', facilities: [facility(sessions)] });
  const next = scheduleSnapshot({ today: '2026-07-24', facilities: [facility(sessions.slice(1))] });
  assert.deepEqual(diffSchedules(previous, next), []);
});

test('a weekly table drifting to the next week is not a schedule change', () => {
  const html = `<main><table>
    <tr><th>Время</th><th>Понедельник</th><th>Вторник</th><th>Среда</th><th>Четверг</th></tr>
    <tr><td>9.15-10.00</td><td>Тренажёрный зал</td><td>Зал штанги</td><td>Зал</td><td>Зал</td></tr>
  </table></main>`;
  const $ = cheerio.load(html);
  // Одна и та же таблица, прочитанная в понедельник и во вторник: сеанс
  // понедельника переезжает на +7 дней, но расписание осталось прежним.
  const monday = scheduleSnapshot({ today: '2026-08-03', facilities: [facility(sessionsFromTables($, $('main'), '2026-08-03'))] });
  const tuesday = scheduleSnapshot({ today: '2026-08-04', facilities: [facility(sessionsFromTables($, $('main'), '2026-08-04'))] });
  assert.notDeepEqual(monday.facilities[0].sessions, tuesday.facilities[0].sessions);
  assert.deepEqual(diffSchedules(monday, tuesday), []);
});
