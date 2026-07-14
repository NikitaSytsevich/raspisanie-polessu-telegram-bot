const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionsFromInline } = require('../lib/schedule');

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
