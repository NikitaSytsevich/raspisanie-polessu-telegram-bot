const crypto = require('crypto');
const { cleanNotice, dateLabel, emojiPrefix, escapeHtml } = require('./format');
const { FACILITIES } = require('./schedule');

// Формат снимка. При изменении полей, участвующих в сравнении, номер нужно
// поднять: снимок предыдущей версии тогда считается базовым и не порождает
// рассылку об «изменениях», которых на сайте не было.
// 3: гребная база впервые отдаёт сеансы, а малый бассейн — свою настоящую
// причину простоя. Обе новости про парсер, а не про сайт, поэтому рассылку о
// них глушим сменой версии.
// 4: из большого бассейна ушёл раздел обучения плаванию — восемь сеансов,
// которые иначе уехали бы в рассылку как снятые с сайта.
// 5: уточнения к сеансам приходят без пробелов по краям, в снимке появились
// поля pending и shown для выдержки уведомлений.
// 6: в снимке появились пометки дней без сеансов («Санитарный день»). Те, что
// уже висят на сайте, — новость про парсер, а не про сайт.
const SNAPSHOT_VERSION = 6;

// Сколько строк изменений показывать одним сообщением. Дальше — «и ещё N»:
// сообщение не должно упереться в лимит размера. Блок длиннее EXPAND_AFTER
// строк сворачивается в раскрывающуюся цитату.
const MAX_ROWS = 40;
const EXPAND_AFTER = 6;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
// Снимок отсортирован по id ради стабильного сравнения, а уведомление идёт в
// том же порядке объектов, что и карточка.
const FACILITY_ORDER = new Map(FACILITIES.map((facility, index) => [facility.id, index]));
const facilityOrder = id => FACILITY_ORDER.get(id) ?? FACILITIES.length;

// Когда сеанс идёт: дата или, у недельного расписания, день недели. Дата
// недельного сеанса сдвигается сама собой, поэтому сравниваем его по дню.
function sessionWhen(session) {
  return session.weekday === undefined ? session.date : `wd${session.weekday}`;
}

function slotKey(session) {
  return `${sessionWhen(session)}|${session.start}|${session.end}`;
}

function sessionKey(session) {
  return `${slotKey(session)}|${session.activity || ''}`;
}

function sortSessions(sessions) {
  return [...sessions].sort((a, b) => sessionKey(a).localeCompare(sessionKey(b)));
}

function noteKey(note) {
  return `${note.date}|${note.note}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

// Недельный сеанс приходит в расписание пачкой копий — по одной на каждую дату
// впереди. Для сравнения они неотличимы, поэтому в снимке держим одну: иначе
// единственная правка на сайте уезжала бы в рассылку семь раз подряд.
function uniqueSessions(sessions) {
  const seen = new Set();
  return sessions.filter(session => {
    const key = sessionKey(session);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      sessions: uniqueSessions(sortSessions(facility.sessions)).map(({ date, weekday, start, end, activity }) => ({
        date, start, end, activity: activity || '',
        ...(weekday === undefined ? {} : { weekday }),
      })),
      dayNotes: [...(facility.dayNotes || [])].sort((a, b) => noteKey(a).localeCompare(noteKey(b)))
        .map(({ date, note }) => ({ date, note })),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// Отпечаток того, что сейчас нарисовано в карточках. Отличается от прошлого —
// карточки перерисовываются, даже если уведомление ещё выжидает: карточка
// не пуш, ей незачем ждать. Время проверки в отпечаток не входит.
function displayFingerprint(payload) {
  return hash(payload.facilities.map(facility => [
    facility.id, facility.status, facility.notice || '', Boolean(facility.stale),
    facility.sessions.map(session => [session.date, session.start, session.end, session.activity || '']),
    (facility.dayNotes || []).map(noteKey),
  ]));
}

// Объект, который не удалось прочитать, — не новость: ни «данные недоступны»,
// ни «все сеансы сняты». В базовом снимке остаётся его последняя удачная
// запись, и когда страница вернётся, сравнение пойдёт с настоящими данными.
function settleSnapshot(previous, next) {
  const before = new Map((previous?.facilities || []).map(facility => [facility.id, facility]));
  return {
    ...next,
    facilities: next.facilities.map(facility => (
      facility.status === 'unavailable' && before.has(facility.id) ? before.get(facility.id) : facility
    )),
  };
}

// Страница объекта показывает и уже прошедшие дни, а парсер держит окно
// «неделя назад — 45 дней вперёд». Поэтому со временем сеансы уходят из
// снимка сами по себе: сравниваем только будущее, иначе смена суток выглядела
// бы как удаление сеансов с сайта. Сегодняшний сеанс, который уже закончился,
// тоже не новость — nowTime отсекает его. Недельные сеансы повторяются и
// отсекаться не должны.
function upcoming(sessions, from, nowTime = '') {
  return sessions.filter(session => session.weekday !== undefined
    || session.date > from
    || (session.date === from && session.end > nowTime));
}

function diffSchedules(previous, next, nowTime = '') {
  const from = next.today || '';
  const oldById = new Map((previous?.facilities || []).map(facility => [facility.id, facility]));
  return next.facilities.map(facility => {
    const before = oldById.get(facility.id);
    // Сравнивать можно только то, что прочиталось и тогда, и сейчас. Объект,
    // впервые попавший в снимок, молча становится базой — как и весь снимок
    // после смены версии.
    if (!before || before.status === 'unavailable' || facility.status === 'unavailable') return null;
    const sessions = upcoming(facility.sessions, from, nowTime);
    const beforeSessions = upcoming(before.sessions, from, nowTime);
    const oldSessions = new Set(beforeSessions.map(sessionKey));
    const newSessions = new Set(sessions.map(sessionKey));
    const removedAll = beforeSessions.filter(session => !newSessions.has(sessionKey(session)));
    // Тот же сеанс с другим уточнением («свободно 6 дорожек» → «5 дорожек») —
    // это правка, а не «снят один и добавлен другой»: собираем такие пары.
    const bySlot = new Map();
    for (const session of removedAll) {
      const key = slotKey(session);
      (bySlot.get(key) || bySlot.set(key, []).get(key)).push(session);
    }
    const changed = [];
    const added = sessions.filter(session => {
      if (oldSessions.has(sessionKey(session))) return false;
      const match = bySlot.get(slotKey(session));
      if (!match?.length) return true;
      changed.push({ before: match.shift(), after: session });
      return false;
    });
    const removed = [...bySlot.values()].flat();
    // Пометки дня сравниваем как сеансы, но только будущие: вчерашний
    // санитарный день уходит из окна разбора сам, это не отмена.
    const notes = (facility.dayNotes || []).filter(note => note.date >= from);
    const beforeNotes = (before.dayNotes || []).filter(note => note.date >= from);
    const oldNotes = new Set(beforeNotes.map(noteKey));
    const newNotes = new Set(notes.map(noteKey));
    const addedNotes = notes.filter(note => !oldNotes.has(noteKey(note)));
    const removedNotes = beforeNotes.filter(note => !newNotes.has(noteKey(note)));
    const statusChanged = before.status !== facility.status || before.notice !== facility.notice;
    return { facility, before, added, removed, changed, addedNotes, removedNotes, statusChanged };
  }).filter(change => change && (change.statusChanged || change.added.length || change.removed.length || change.changed.length
    || change.addedNotes.length || change.removedNotes.length))
    .sort((a, b) => facilityOrder(a.facility.id) - facilityOrder(b.facility.id));
}

function changesFingerprint(changes) {
  return hash(changes.map(change => [
    change.facility.id, change.facility.status, change.facility.notice,
    change.added.map(sessionKey), change.removed.map(sessionKey),
    change.changed.map(({ before, after }) => [sessionKey(before), sessionKey(after)]),
    change.addedNotes.map(noteKey), change.removedNotes.map(noteKey),
  ]));
}

// Решение одной проверки. Изменение на сайте сначала только замечается:
// карточки перерисовываются сразу, а уведомление ждёт следующей проверки и
// уходит, если набор изменений за пять минут не поменялся. Серия быстрых
// правок приезжает одним сообщением, а публикация, которую тут же откатили, —
// ни одним. Базовый снимок сдвигается только вместе с уведомлением.
function planCheck(stored, payload, nowTime = '') {
  const snapshot = scheduleSnapshot(payload);
  const shown = displayFingerprint(payload);
  const previous = stored?.version === SNAPSHOT_VERSION ? stored : null;
  // Снимок старого формата сравнивать не с чем: молча сохраняем новый.
  if (!previous) {
    return { baseline: true, dayChanged: true, refresh: true, changes: [], notify: [], save: { ...snapshot, pending: null, shown } };
  }
  const next = settleSnapshot(previous, snapshot);
  const changes = diffSchedules(previous, next, nowTime);
  const pending = changes.length ? changesFingerprint(changes) : null;
  const settled = pending !== null && pending === previous.pending;
  const dayChanged = previous.today !== next.today;
  const base = settled || !pending ? next : { ...previous, today: next.today };
  return {
    baseline: false,
    dayChanged,
    // Первая проверка нового дня обновляет карточки даже без изменений:
    // иначе до первого нажатия кнопки они показывают вчерашнюю дату.
    refresh: dayChanged || previous.shown !== shown,
    changes,
    notify: settled ? changes : [],
    save: { ...base, pending: settled ? null : pending, shown },
  };
}

function slot(session) {
  return `${session.start}–${session.end}`;
}

function sessionRow(sign, session) {
  return `${sign} ${slot(session)}${session.activity ? ` · ${escapeHtml(session.activity)}` : ''}`;
}

function changedRow({ before, after }) {
  return `✏️ ${slot(after)} · <s>${escapeHtml(before.activity || '—')}</s> → ${escapeHtml(after.activity || '—')}`;
}

// «пн–пт» для подряд идущих дней, «сб, вс» — для остальных.
function weekdaysLabel(days) {
  const positions = [...new Set(days)].map(day => WEEK_ORDER.indexOf(day)).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < positions.length;) {
    let j = i;
    while (j + 1 < positions.length && positions[j + 1] === positions[j] + 1) j += 1;
    const first = WEEKDAY_SHORT[WEEK_ORDER[positions[i]]];
    const last = WEEKDAY_SHORT[WEEK_ORDER[positions[j]]];
    if (j - i >= 2) parts.push(`${first}–${last}`);
    else for (let k = i; k <= j; k++) parts.push(WEEKDAY_SHORT[WEEK_ORDER[positions[k]]]);
    i = j + 1;
  }
  return parts.join(', ');
}

function statusRow(change) {
  const { facility, before } = change;
  if (facility.status === 'closed') return `⛔ ${escapeHtml(cleanNotice(facility.notice) || 'Объект закрыт')}`;
  if (before?.status === 'closed') return '✅ Снова работает — сеансы в карточке';
  return '';
}

// Строки изменений одного объекта: по датам с днём недели, внутри — по времени.
// Недельные сеансы идут одной строкой на все дни с одинаковой правкой: смена
// времени «с понедельника по пятницу» — это одна строка «пн–пт», а не пять.
function changeLines(change) {
  const status = statusRow(change);
  // Закрытие и открытие объекта сами по себе новость: перечислять в придачу
  // все снятые или вернувшиеся сеансы — это полсотни строк шума.
  if (change.statusChanged && (change.facility.status === 'closed' || change.before?.status === 'closed')) return [status];
  const items = [
    ...change.added.map(session => ({ session, order: 0, row: sessionRow('➕', session) })),
    ...change.changed.map(pair => ({ session: pair.after, order: 1, row: changedRow(pair) })),
    ...change.removed.map(session => ({ session, order: 2, row: sessionRow('➖', session) })),
  ].sort((a, b) => a.session.start.localeCompare(b.session.start) || a.order - b.order);

  const dated = new Map();
  const weekly = new Map();
  // Пометка дня идёт первой строкой под датой: она объясняет снятые сеансы.
  const notes = [
    ...change.addedNotes.map(note => ({ date: note.date, row: `⛔ ${escapeHtml(note.note)}` })),
    ...change.removedNotes.map(note => ({ date: note.date, row: `✅ <s>${escapeHtml(note.note)}</s>` })),
  ];
  for (const { date, row } of notes) (dated.get(date) || dated.set(date, []).get(date)).push(row);
  for (const { session, row } of items) {
    if (session.weekday === undefined) {
      (dated.get(session.date) || dated.set(session.date, []).get(session.date)).push(row);
    } else {
      (weekly.get(row) || weekly.set(row, []).get(row)).push(session.weekday);
    }
  }
  const lines = status ? [status] : [];
  for (const date of [...dated.keys()].sort()) lines.push(`<b>${dateLabel(date, true)}</b>`, ...dated.get(date));
  for (const [row, days] of weekly) lines.push(`<b>${weekdaysLabel(days)}</b> ${row}`);
  return lines;
}

// Первая строка сообщения — то, что видно в пуше. Поэтому никакого вступления:
// заголовок, затем сразу объект и его правки.
function formatChangeAlert(changes) {
  const blocks = ['<h3>Изменения в расписании</h3>'];
  let budget = MAX_ROWS;
  for (const change of changes) {
    const { facility } = change;
    const lines = changeLines(change);
    const shown = lines.slice(0, Math.max(budget, 1));
    budget -= shown.length;
    if (shown.length < lines.length) shown.push(`и ещё ${lines.length - shown.length} — на странице объекта`);
    const quote = shown.length > EXPAND_AFTER ? '<blockquote expandable>' : '<blockquote>';
    blocks.push(`<p>${emojiPrefix(facility.id)}<b><a href="${escapeHtml(facility.sourceUrl)}">${escapeHtml(facility.name)}</a></b></p>${quote}${shown.join('<br />')}</blockquote>`);
  }
  blocks.push('<footer>Карточка расписания уже обновлена</footer>');
  return blocks.join('');
}

module.exports = { SNAPSHOT_VERSION, diffSchedules, formatChangeAlert, planCheck, scheduleSnapshot, settleSnapshot, weekdaysLabel };
