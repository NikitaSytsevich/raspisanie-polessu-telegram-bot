const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { sessionsFromTables } = require('../lib/schedule');
const { scheduleSnapshot, diffSchedules, formatChangeAlert, planCheck, weekdaysLabel } = require('../lib/change-monitor');

const facility = sessions => ({ id: 'pool', name: 'Бассейн', sourceUrl: 'https://example.test/pool', status: 'ok', sessions });
const session = (date, start, end, activity = '') => ({ date, start, end, activity });

test('change monitor ignores unstable generated time and finds only schedule changes', () => {
  const previous = scheduleSnapshot({ generatedAt: 'one', facilities: [facility([{ date: '2026-07-16', start: '10:00', end: '11:00', activity: '' }])] });
  const same = scheduleSnapshot({ generatedAt: 'two', facilities: [facility([{ date: '2026-07-16', start: '10:00', end: '11:00', activity: '' }])] });
  assert.deepEqual(diffSchedules(previous, same), []);

  const next = scheduleSnapshot({ facilities: [facility([{ date: '2026-07-16', start: '11:30', end: '12:30', activity: '3 дорожки' }])] });
  const changes = diffSchedules(previous, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].added[0].start, '11:30');
  assert.equal(changes[0].removed[0].start, '10:00');
  assert.match(formatChangeAlert(changes), /Изменения в расписании/);
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

test('a page that failed to load is not news, and neither is its return', () => {
  const sessions = [session('2026-09-24', '21:00', '21:45', 'Массовое катание')];
  const ok = { today: '2026-09-23', facilities: [facility(sessions)] };
  const down = { today: '2026-09-23', facilities: [{ ...facility([]), status: 'unavailable' }] };

  // Один таймаут сайта раньше рассылал «данные недоступны» и «➖» по каждому
  // сеансу, а через пять минут — «➕» по каждому обратно.
  const first = planCheck(null, ok);
  const outage = planCheck(first.save, down);
  assert.deepEqual(outage.changes, []);
  const back = planCheck(outage.save, ok);
  assert.deepEqual(back.changes, []);
  assert.deepEqual(back.notify, []);
  // База хранит последнее удачное чтение, и настоящая правка после сбоя
  // сравнивается с ним, а не с пустотой.
  assert.deepEqual(outage.save.facilities, first.save.facilities);
});

test('an alert waits for the change to hold through one more check', () => {
  const before = { today: '2026-09-23', facilities: [facility([session('2026-09-24', '10:00', '11:00')])] };
  const edited = { today: '2026-09-23', facilities: [facility([session('2026-09-24', '10:00', '11:00'), session('2026-09-24', '12:00', '13:00')])] };

  const base = planCheck(null, before).save;
  // Правку заметили: карточки перерисовываются сразу, уведомление ждёт.
  const seen = planCheck(base, edited);
  assert.equal(seen.changes.length, 1);
  assert.equal(seen.refresh, true);
  assert.deepEqual(seen.notify, []);
  // Через пять минут правка на месте — уведомление уходит, база сдвигается.
  const held = planCheck(seen.save, edited);
  assert.equal(held.notify.length, 1);
  assert.equal(held.refresh, false);
  assert.equal(held.save.pending, null);
  assert.deepEqual(planCheck(held.save, edited).changes, []);

  // Правку откатили до второй проверки: уведомления нет, карточки вернулись.
  const reverted = planCheck(seen.save, before);
  assert.deepEqual(reverted.notify, []);
  assert.equal(reverted.refresh, true);
  assert.equal(reverted.save.pending, null);
});

test('a burst of edits arrives as one alert about the final state', () => {
  const at = (...starts) => ({ today: '2026-09-23', facilities: [facility(starts.map(start => session('2026-09-24', start, `${start.slice(0, 2)}:45`)))] });
  const base = planCheck(null, at('10:00')).save;
  const first = planCheck(base, at('10:00', '12:00'));
  const second = planCheck(first.save, at('10:00', '12:00', '14:00'));
  assert.deepEqual(second.notify, []);
  const held = planCheck(second.save, at('10:00', '12:00', '14:00'));
  // Обе правки — в одном сообщении, и сравнение идёт с исходной базой.
  assert.deepEqual(held.notify[0].added.map(item => item.start), ['12:00', '14:00']);
});

test('a new note on the same session reads as an edit, not as removed plus added', () => {
  const previous = scheduleSnapshot({ today: '2026-09-23', facilities: [facility([session('2026-09-24', '10:30', '11:15', 'свободно 6 дорожек')])] });
  const next = scheduleSnapshot({ today: '2026-09-23', facilities: [facility([session('2026-09-24', '10:30', '11:15', 'свободно 5 дорожек')])] });
  const [change] = diffSchedules(previous, next);
  assert.deepEqual(change.added, []);
  assert.deepEqual(change.removed, []);
  assert.equal(change.changed.length, 1);
  const html = formatChangeAlert([change]);
  assert.match(html, /<b>чт 24\.09<\/b><br \/>✏️ 10:30–11:15 · <s>свободно 6 дорожек<\/s> → свободно 5 дорожек/);
});

test('sessions that already ended today are not reported', () => {
  const previous = scheduleSnapshot({ today: '2026-09-23', facilities: [facility([session('2026-09-23', '09:15', '10:00'), session('2026-09-23', '20:15', '21:00')])] });
  const next = scheduleSnapshot({ today: '2026-09-23', facilities: [facility([session('2026-09-23', '20:15', '21:00')])] });
  // В 12:00 утренний сеанс уже прошёл: уборка его со страницы — не новость.
  assert.deepEqual(diffSchedules(previous, next, '12:00'), []);
  assert.equal(diffSchedules(previous, next, '09:30').length, 1);
});

test('weekly edits collapse into one line per set of days', () => {
  assert.equal(weekdaysLabel([1, 2, 3, 4, 5]), 'пн–пт');
  assert.equal(weekdaysLabel([6, 0]), 'сб, вс');
  assert.equal(weekdaysLabel([1, 3, 4, 5, 0]), 'пн, ср–пт, вс');

  const weekly = (start, end) => [1, 2, 3, 4, 5].map(weekday => ({ date: '2026-09-28', weekday, start, end, activity: 'Тренажёрный зал' }));
  const previous = scheduleSnapshot({ today: '2026-09-23', facilities: [facility(weekly('18:30', '19:30'))] });
  const next = scheduleSnapshot({ today: '2026-09-23', facilities: [facility(weekly('18:00', '19:00'))] });
  const html = formatChangeAlert(diffSchedules(previous, next));
  assert.match(html, /<b>пн–пт<\/b> ➕ 18:00–19:00 · Тренажёрный зал<br \/><b>пн–пт<\/b> ➖ 18:30–19:30/);
});

test('closing a facility is one line, not a list of every removed session', () => {
  const sessions = Array.from({ length: 30 }, (_, i) => session('2026-09-24', `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, '23:00'));
  const previous = scheduleSnapshot({ today: '2026-09-23', facilities: [facility(sessions)] });
  const next = scheduleSnapshot({ today: '2026-09-23', facilities: [{ ...facility([]), status: 'closed', notice: 'Бассейн закрыт на ремонт!!!' }] });
  const html = formatChangeAlert(diffSchedules(previous, next));
  assert.match(html, /<blockquote>⛔ Бассейн закрыт на ремонт<\/blockquote>/);
  assert.doesNotMatch(html, /➖/);
  const reopened = formatChangeAlert(diffSchedules(next, previous));
  assert.match(reopened, /✅ Снова работает/);
  assert.doesNotMatch(reopened, /➕/);
});

test('a new closed day leads its date and explains the removed sessions', () => {
  const previous = scheduleSnapshot({ today: '2026-10-13', facilities: [facility([session('2026-10-14', '09:15', '10:00')])] });
  const next = scheduleSnapshot({
    today: '2026-10-13',
    facilities: [{ ...facility([]), dayNotes: [{ date: '2026-10-14', note: 'Санитарный день' }] }],
  });
  const changes = diffSchedules(previous, next);
  assert.equal(changes.length, 1);
  assert.match(formatChangeAlert(changes), /<b>ср 14\.10<\/b><br \/>⛔ Санитарный день<br \/>➖ 09:15–10:00/);
  assert.match(formatChangeAlert(diffSchedules(next, previous)), /✅ <s>Санитарный день<\/s>/);
  // Прошедший санитарный день уходит из окна разбора сам — это не отмена.
  const later = scheduleSnapshot({ today: '2026-10-15', facilities: [facility([])] });
  assert.deepEqual(diffSchedules(next, later), []);
});

test('a long list folds into an expandable quote instead of being cut short', () => {
  const previous = scheduleSnapshot({ today: '2026-09-23', facilities: [facility([])] });
  const many = Array.from({ length: 8 }, (_, i) => session('2026-09-24', `${String(9 + i).padStart(2, '0')}:00`, `${String(9 + i).padStart(2, '0')}:45`));
  const next = scheduleSnapshot({ today: '2026-09-23', facilities: [facility(many)] });
  const html = formatChangeAlert(diffSchedules(previous, next));
  assert.match(html, /<blockquote expandable>/);
  assert.equal((html.match(/➕/g) || []).length, 8);
  assert.doesNotMatch(html, /и ещё/);
});
