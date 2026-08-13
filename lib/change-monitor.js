const { emojiPrefix, escapeHtml } = require('./format');
const { TZ } = require('./schedule');

// Формат снимка. При изменении полей, участвующих в сравнении, номер нужно
// поднять: снимок предыдущей версии тогда считается базовым и не порождает
// рассылку об «изменениях», которых на сайте не было.
const SNAPSHOT_VERSION = 2;

function sessionKey(session) {
  // Сеансы недельной таблицы помечены днём недели: их дата сдвигается сама
  // собой, поэтому такие сеансы сравниваем по дню недели, а не по дате.
  const when = session.weekday === undefined ? session.date : `wd${session.weekday}`;
  return `${when}|${session.start}|${session.end}|${session.activity || ''}`;
}

function sortSessions(sessions) {
  return [...sessions].sort((a, b) => sessionKey(a).localeCompare(sessionKey(b)));
}

function scheduleSnapshot(payload) {
  return {
    version: SNAPSHOT_VERSION,
    // Дата нужна утренней проверке QStash: при смене дня карточки обновляются,
    // даже если само расписание не изменилось. diffSchedules это поле не сравнивает.
    today: payload.today || '',
    facilities: payload.facilities.map(facility => ({
      id: facility.id,
      name: facility.name,
      sourceUrl: facility.sourceUrl,
      status: facility.status,
      notice: facility.notice || '',
      sessions: sortSessions(facility.sessions).map(({ date, weekday, start, end, activity }) => ({
        date, start, end, activity: activity || '',
        ...(weekday === undefined ? {} : { weekday }),
      })),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// Страница объекта показывает и уже прошедшие дни, а парсер держит окно
// «неделя назад — 45 дней вперёд». Поэтому со временем сеансы уходят из
// снимка сами по себе: сравниваем только сегодняшний день и будущее, иначе
// смена суток выглядела бы как удаление сеансов с сайта.
function upcoming(sessions, from) {
  return sessions.filter(session => session.weekday !== undefined || session.date >= from);
}

function diffSchedules(previous, next) {
  const from = next.today || '';
  const oldById = new Map((previous?.facilities || []).map(facility => [facility.id, facility]));
  return next.facilities.map(facility => {
    const sessions = upcoming(facility.sessions, from);
    const before = oldById.get(facility.id);
    if (!before) return { facility, added: sessions, removed: [], statusChanged: true };
    const beforeSessions = upcoming(before.sessions, from);
    const oldSessions = new Set(beforeSessions.map(sessionKey));
    const newSessions = new Set(sessions.map(sessionKey));
    const added = sessions.filter(session => !oldSessions.has(sessionKey(session)));
    const removed = beforeSessions.filter(session => !newSessions.has(sessionKey(session)));
    const statusChanged = before.status !== facility.status || before.notice !== facility.notice;
    return { facility, added, removed, statusChanged };
  }).filter(change => change.statusChanged || change.added.length || change.removed.length);
}

function sessionLabel(session) {
  const date = new Date(`${session.date}T12:00:00Z`);
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(date);
  return `${day} · ${session.start}–${session.end}${session.activity ? ` — ${session.activity}` : ''}`;
}

function statusLabel(facility) {
  if (facility.status === 'ok') return 'расписание опубликовано';
  if (facility.status === 'closed') return facility.notice || 'объект временно закрыт';
  if (facility.status === 'not_published') return 'расписание пока не опубликовано';
  return 'данные временно недоступны';
}

function formatChangeAlert(changes) {
  const blocks = ['<h3>Расписание обновлено</h3>', '<p>На официальном сайте ПолесГУ появились изменения.</p>'];
  for (const change of changes.slice(0, 4)) {
    const { facility } = change;
    const rows = [];
    if (change.statusChanged) rows.push(`Статус: ${statusLabel(facility)}`);
    for (const session of change.added.slice(0, 3)) rows.push(`➕ ${sessionLabel(session)}`);
    for (const session of change.removed.slice(0, 3)) rows.push(`➖ ${sessionLabel(session)}`);
    const more = change.added.length + change.removed.length - Math.min(change.added.length, 3) - Math.min(change.removed.length, 3);
    if (more > 0) rows.push(`и ещё ${more}`);
    blocks.push(`<p>${emojiPrefix(facility.id)}<b><a href="${escapeHtml(facility.sourceUrl)}">${escapeHtml(facility.name)}</a></b><br />${rows.map(escapeHtml).join('<br />')}</p>`);
  }
  if (changes.length > 4) blocks.push(`<p>И ещё объектов: ${changes.length - 4}.</p>`);
  blocks.push('<footer>Карточка расписания выше уже обновлена.</footer>');
  return blocks.join('');
}

module.exports = { SNAPSHOT_VERSION, scheduleSnapshot, diffSchedules, formatChangeAlert };
