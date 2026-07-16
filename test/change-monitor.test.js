const test = require('node:test');
const assert = require('node:assert/strict');
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
