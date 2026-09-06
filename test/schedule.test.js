const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { addDays, getSchedule, sessionsFromInline, sessionsFromTables, sessionsFromWeekdayRanges, todayIso } = require('../lib/schedule');

// Все четыре объекта в этих тестах читают одну и ту же подставную страницу:
// проверяется поведение разбора, а не разница между сайтами.
async function withPage(html, run) {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  });
  try { return await run(); } finally { global.fetch = original; }
}


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
  // Вместе с датой сохраняется день недели: по нему сеансы недельной таблицы
  // сравниваются между проверками, иначе их сдвиг читался бы как изменение.
  assert.deepEqual(sessions, [
    { date: '2026-07-13', weekday: 1, start: '09:15', end: '10:00', activity: 'Тренажёрный зал' },
    { date: '2026-07-15', weekday: 3, start: '09:15', end: '10:00', activity: 'Зал штанги' },
    { date: '2026-07-14', weekday: 2, start: '18:00', end: '19:30', activity: 'Тренажёрный зал' },
    { date: '2026-07-16', weekday: 4, start: '18:00', end: '19:30', activity: 'Зал штанги' },
  ]);
});

// Страница гребной базы свёрстана третьим способом: ни таблицы, ни дат —
// диапазон дней недели словами и сеансы следом за ним.
test('a weekday range with the sessions right after it is read as a weekly schedule', () => {
  const sessions = sessionsFromWeekdayRanges(
    'Расписание ТРЕНАЖЕРНОГО ЗАЛА и ЗАЛА СИЛОВОЙ ПОДГОТОВКИ Понедельник- Пятница 18.30-19.30 19.30- 20.30 ОПЛАТА УСЛУГ ЧЕРЕЗ СИСТЕМУ ЕРИП',
    '2026-09-06',
  );
  assert.deepEqual(sessions.map(session => `${session.weekday} ${session.start}–${session.end}`), [
    '1 18:30–19:30', '2 18:30–19:30', '3 18:30–19:30', '4 18:30–19:30', '5 18:30–19:30',
    '1 19:30–20:30', '2 19:30–20:30', '3 19:30–20:30', '4 19:30–20:30', '5 19:30–20:30',
  ]);
  // Понедельник ближайший — завтра: у недельных сеансов дата вычисляется, и
  // день недели рядом с ней обязателен для сравнения между проверками.
  assert.equal(sessions[0].date, '2026-09-07');
});

test('dashes and «по» mean a range of days, commas and «и» mean a list', () => {
  const days = text => sessionsFromWeekdayRanges(`${text} 07.00-08.00`, '2026-09-06').map(session => session.weekday);
  assert.deepEqual(days('с понедельника по пятницу'), [1, 2, 3, 4, 5]);
  assert.deepEqual(days('Суббота-Воскресенье'), [6, 0]);
  assert.deepEqual(days('Понедельник, Среда, Пятница'), [1, 3, 5]);
  assert.deepEqual(days('Вторник и Четверг'), [2, 4]);
});

test('times outside the schedule itself do not become sessions', () => {
  const none = text => assert.deepEqual(sessionsFromWeekdayRanges(text, '2026-09-06'), []);
  // Часы работы кассы стоят в служебном хвосте страницы, сразу за днём недели.
  none('в понедельник оплатить услуги можно в кассах с 09.00-21.00');
  // «Средства» — не «среда»: день недели должен кончаться на границе слова.
  none('Денежные средства 10.00-11.00 возвращаются');
  // Время, оторванное от дней недели, относится уже к другому тексту.
  none(`Понедельник ${'текст '.repeat(20)} 10.00-11.00`);
});

test('a closed facility reports the reason named on its own page', async () => {
  const html = `<html><body><main>Расписание малого бассейна.
    В связи с плановым проведением ремонтных работ малый бассейн закрыт. Приносим свои извинения.
  </main></body></html>`;
  const payload = await withPage(html, () => getSchedule({ force: true }));
  const pool = payload.facilities.find(facility => facility.id === 'small_pool');
  assert.equal(pool.status, 'closed');
  // Заготовка «пока не опубликовано» однажды пережила свою причину и молчала
  // о ремонте: причину простоя всегда берём со страницы объекта.
  assert.match(pool.notice, /ремонтных работ малый бассейн закрыт/);
});

test('a weekly schedule keeps filling the card weeks ahead', async () => {
  const html = '<html><body><main>Понедельник- Пятница 18.30-19.30</main></body></html>';
  const payload = await withPage(html, () => getSchedule({ force: true }));
  const base = payload.facilities.find(facility => facility.id === 'rowing_base');
  assert.equal(base.status, 'ok');
  // Расписание недельное и постоянное, поэтому листание карточки не должно
  // упираться в пустые дни через неделю после ближайшего понедельника.
  const monday = base.sessions.find(session => session.weekday === 1);
  assert.ok(base.sessions.some(session => session.date === addDays(monday.date, 21)));
  assert.equal(base.sessions.find(session => session.date === addDays(monday.date, 21)).activity, 'Тренажёрный зал');
  // Выходных в этом расписании нет — их бот и не выдумывает.
  assert.equal(base.sessions.some(session => session.weekday === 0 || session.weekday === 6), false);
});
