const cheerio = require('cheerio');

const TZ = 'Europe/Minsk';
const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 90_000;
const MAX_BYTES = 3 * 1024 * 1024;

// Эмодзи стоит рядом с названием намеренно: клавиатура карточки подписывает
// объекты только им и рассчитывает уместить все кнопки в один ряд. Держи их в
// разных модулях — и новый объект однажды приедет в ряд полным названием.
const FACILITIES = [
  ['ice_arena', 'Ледовая арена', '⛸', 'https://www.polessu.by/%D0%BB%D0%B5%D0%B4%D0%BE%D0%B2%D0%B0%D1%8F-%D0%B0%D1%80%D0%B5%D0%BD%D0%B0-%D0%BF%D0%BE%D0%BB%D0%B5%D1%81%D0%B3%D1%83'],
  ['sports_pool', 'Большой бассейн', '🏊', 'https://www.polessu.by/%D0%B1%D0%BE%D0%BB%D1%8C%D1%88%D0%BE%D0%B9-%D0%B1%D0%B0%D1%81%D1%81%D0%B5%D0%B9%D0%BD'],
  ['small_pool', 'Малый бассейн', '🌊', 'https://www.polessu.by/%D0%BC%D0%B0%D0%BB%D1%8B%D0%B9-%D0%B1%D0%B0%D1%81%D1%81%D0%B5%D0%B9%D0%BD'],
  ['rowing_base', 'Гребная база', '🚣', 'https://www.polessu.by/%D1%80%D0%B0%D1%81%D0%BF%D0%B8%D1%81%D0%B0%D0%BD%D0%B8%D0%B5-%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D1%8B-%D1%82%D1%80%D0%B5%D0%BD%D0%B0%D0%B6%D0%B5%D1%80%D0%BD%D0%BE%D0%B3%D0%BE-%D0%B7%D0%B0%D0%BB%D0%B0-%D0%B8-%D0%B7%D0%B0%D0%BB%D0%B0-%D1%88%D1%82%D0%B0%D0%BD%D0%B3%D0%B8-%D0%B3%D1%80%D0%B5%D0%B1%D0%BD%D0%B0%D1%8F-%D0%B1%D0%B0%D0%B7%D0%B0-%E2%84%961'],
].map(([id, name, emoji, sourceUrl]) => ({ id, name, emoji, sourceUrl }));

const WEEKDAYS = [
  ['воскресенье', 0], ['понедельник', 1], ['вторник', 2], ['среда', 3],
  ['четверг', 4], ['пятница', 5], ['суббота', 6],
];
// Между днём недели и датой допускаем запятую, скобку и тире («Понедельник,
// 21.09.2026»), год — из четырёх или двух цифр. Без года дату не берём:
// «Суббота 10.05 – 11.00» прочиталось бы как 10 мая, а не как сеанс.
const DATE_DAY_RE = /(?:понедельник|вторник|сред[ауы]|четверг|пятниц[аы]|суббот[аы]|воскресень[еяю])[\s,.(–—-]*(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})/giu;
const WEEKDAYS_SHORT = { вс: 0, пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6 };
const SLOT_RE = /(\d{1,2})[.:](\d{2})\s*[–—-]\s*(\d{1,2})[.:](\d{2})/g;
// Для одиночного поиска с группами часов и минут: String.match с глобальным
// регулярным выражением возвращает только полные совпадения без групп.
const SINGLE_SLOT_RE = new RegExp(SLOT_RE.source);

// Третья вёрстка расписания: ни таблицы, ни дат — только дни недели словами и
// сеансы следом («Понедельник- Пятница 18.30-19.30»). Окончание падежа берём
// любое: на страницах встречается и «с понедельника по пятницу». Хвост
// «(?![а-яё])» обязателен — без него «средства» прочитались бы как «среда».
const WEEKDAY_STEM_RE = '(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)[а-яё]{0,2}(?![а-яё])';
const WEEKDAY_ANY_RE = `(?:${WEEKDAY_STEM_RE}|(?:пн|вт|ср|чт|пт|сб|вс)(?![а-яё]))`;
const WEEKDAY_JOIN_RE = '(?:\\s*[–—-]\\s*|\\s*,\\s*|\\s+(?:и|по)\\s+)';
const WEEKDAY_GROUP_RE = new RegExp(`${WEEKDAY_ANY_RE}(?:${WEEKDAY_JOIN_RE}${WEEKDAY_ANY_RE})*`, 'giu');
const WEEKDAY_ONE_RE = new RegExp(WEEKDAY_ANY_RE, 'giu');
// Диапазон дней недели пишут и тире, и предлогом: «Понедельник- Пятница»,
// «с понедельника по пятницу». Запятая и «и» — наоборот, перечисление.
// Пробелы вокруг «по» обязательны, иначе предлог нашёлся бы в «понедельник».
const WEEKDAY_SPAN_RE = /[–—-]|\sпо\s/u;
// Служебный хвост страницы (оплата, абонементы, часы работы касс) идёт после
// расписания и тоже пестрит временем — разбор на нём обрываем.
const SERVICE_TEXT_RE = /(?:оплат|стоимость|абонемент|ерип|касс|прейскурант|желаем\s+вам)/iu;
// Занятия с тренером — не сеанс свободного посещения, а запись в группу:
// объекту они нужны, боту нет. На странице такой раздел живёт своим блоком
// дней недели после основного расписания, и вырезать его надо до разбора —
// у якоря последнего датированного дня нет правой границы, кроме новой даты,
// поэтому весь блок обучения иначе приезжает в этот день чужими сеансами.
const EXCLUDED_SECTION_RE = /обучени[ея]\s+плавани[июя]/iu;
// Сеансы стоят вплотную к дням недели; разрыв больше этого — уже другой текст.
const WEEKLY_SLOT_GAP = 60;
// Недельное расписание висит на сайте постоянно, поэтому одной ближайшей даты
// мало: без повторов карточка через неделю сказала бы «сеансов на эту дату нет».
const WEEKLY_HORIZON_DAYS = 45;
// Пометка дня без сеансов — короткая фраза («Санитарный день»). Длиннее — уже
// не пометка, а абзац текста, случайно оказавшийся за датой.
const DAY_NOTE_MAX = 80;
// Разобранное расписание лежит в Redis: его пишет каждая проверка QStash, и
// кнопкам незачем заново качать и разбирать четыре страницы, пока оно свежее.
const STORED_FRESH_MS = 10 * 60_000;
// Сколько карточка показывает последние удачные данные объекта, чья страница
// перестала читаться. Дальше честно говорим, что данных нет.
const LAST_GOOD_MS = 24 * 60 * 60_000;

let cache = null;

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function currentTime(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
}

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalize(text) {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function time(h, m) {
  const hours = Number(h);
  const minutes = Number(m);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function weekday(text) {
  const value = normalize(text).toLowerCase();
  const found = WEEKDAYS.find(([name]) => value.startsWith(name.slice(0, Math.min(4, name.length))));
  if (found) return found[1];
  // Шапка таблицы бывает и сокращённой: «Пн», «Вт», «Ср.». Принимаем короткую
  // форму, только если дальше не идёт буква — чтобы «время» не стало вторником.
  const short = WEEKDAYS_SHORT[value.slice(0, 2)];
  if (short !== undefined && !/^[а-яё]/.test(value.slice(2, 3))) return short;
  return -1;
}

function nextDateForWeekday(today, target) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((target - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'raspisanie-polessu-telegram-bot/1.0', 'Accept-Language': 'ru' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Заголовок может врать или отсутствовать, поэтому длину проверяем дважды:
    // до чтения тела (чтобы не тянуть заведомо лишнее) и после.
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('response too large');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error('response too large');
    const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') || '')?.[1] || 'utf-8';
    try { return new TextDecoder(charset).decode(body); } catch { return body.toString('utf8'); }
  } finally {
    clearTimeout(timer);
  }
}

function contentText(html) {
  const $ = cheerio.load(html);
  let root = $('div.field-item[property="content:encoded"]').first();
  if (!root.length) root = $('.node-raspisanie .field-name-body').first();
  if (!root.length) root = $('main').first();
  if (!root.length) root = $('body').first();
  // Новые страницы сайта вставляют <style> прямо в тело статьи: без чистки CSS
  // попал бы в разбираемый текст.
  root.find('style, script, noscript').remove();
  // Cheerio сохраняет пробелы и переносы из исходной Drupal-разметки;
  // normalise ниже превращает их в единый разделитель, не склеивая слоты.
  return { $, root, text: normalize(root.text()) };
}

function stripExcludedSections(text) {
  const start = EXCLUDED_SECTION_RE.exec(text);
  if (!start) return text;
  const rest = text.slice(start.index + start[0].length);
  // Докуда вообще искать сеансы раздела: до следующей даты основного
  // расписания или до служебного хвоста страницы.
  DATE_DAY_RE.lastIndex = 0;
  const bounds = [DATE_DAY_RE.exec(rest)?.index, SERVICE_TEXT_RE.exec(rest)?.index].filter(index => index >= 0);
  const scope = rest.slice(0, bounds.length ? Math.min(...bounds) : rest.length);
  // Режем ровно по последнему сеансу раздела, а не до самой границы: дальше
  // идёт обычный текст страницы, и в нём объект объясняет свой простой.
  const slots = [...scope.matchAll(SLOT_RE)];
  const last = slots[slots.length - 1];
  const after = last ? last.index + last[0].length : 0;
  const tail = last ? /^\s*\([^)]{0,140}\)/.exec(scope.slice(after))?.[0].length || 0 : 0;
  // Разделов может быть несколько; каждый проход короче предыдущего минимум на
  // заголовок, поэтому рекурсия конечна.
  return stripExcludedSections(`${text.slice(0, start.index)} ${rest.slice(after + tail)}`);
}

// Даты в тексте и кусок страницы за каждой из них — до следующей даты.
function dateChunks(text) {
  const anchors = [];
  let match;
  DATE_DAY_RE.lastIndex = 0;
  while ((match = DATE_DAY_RE.exec(text))) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    anchors.push({ index: match.index, end: DATE_DAY_RE.lastIndex, date: `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` });
  }
  return anchors.map((anchor, i) => ({
    date: anchor.date,
    chunk: text.slice(anchor.end, i + 1 < anchors.length ? anchors[i + 1].index : text.length),
  }));
}

function inWindow(date, today) {
  return date >= addDays(today, -7) && date <= addDays(today, 45);
}

function sessionsFromInline(text, today) {
  const sessions = [];
  for (const { date, chunk } of dateChunks(text)) {
    const slots = [...chunk.matchAll(SLOT_RE)];
    for (let j = 0; j < slots.length; j++) {
      const slot = slots[j];
      const start = time(slot[1], slot[2]);
      const end = time(slot[3], slot[4]);
      if (!start || !end || start >= end) continue;
      const after = chunk.slice(slot.index + slot[0].length, j + 1 < slots.length ? slots[j + 1].index : chunk.length);
      // Дополнение к сеансу на сайте бывает только в скобках сразу после времени
      // (например, число свободных дорожек). Не берём остаток страницы: иначе
      // последний сеанс дня «съедает» оплату, абонементы и прочий служебный текст.
      // Пробелы по краям уточнения на сайте случайны («без 1 крайней »): их
      // правка не должна уходить в рассылку как изменение сеанса.
      const activity = normalize(/^\s*\(([^)]{1,140})\)/.exec(after)?.[1]);
      sessions.push({ date, start, end, activity });
    }
  }
  return sessions.filter(s => inWindow(s.date, today));
}

// День без сеансов, за датой которого сайт пишет причину: «Среда 14.10.2026
// Санитарный день». Без неё карточка сказала бы «сеансов на эту дату нет», и
// закрытый бассейн выглядел бы как пробел в расписании. Берём только короткую
// фразу сразу за датой: за последней датой страницы идёт её служебный хвост.
function dayNotesFromInline(text, today) {
  const notes = [];
  for (const { date, chunk } of dateChunks(text)) {
    if (SINGLE_SLOT_RE.test(chunk) || !inWindow(date, today)) continue;
    // Фразу со служебным словом отбрасываем целиком, а не режем по нему:
    // иначе «Срок действия абонементов» стало бы пометкой «Срок действия».
    const lead = normalize(chunk.split(/[.!?]/)[0]);
    if (/^[а-яё]/iu.test(lead) && lead.length <= DAY_NOTE_MAX && !SERVICE_TEXT_RE.test(lead)) notes.push({ date, note: lead });
  }
  return notes;
}

function sessionsFromTables($, root, today) {
  const sessions = [];
  root.find('table').each((_, table) => {
    const rows = $(table).find('tr').toArray().map(row => $(row).find('th,td').toArray());
    if (rows.length < 2) return;
    const header = rows[0].map(cell => weekday($(cell).text()));
    if (header.filter(n => n >= 0).length < 3) return;
    for (const row of rows.slice(1)) {
      const range = SINGLE_SLOT_RE.exec(normalize($(row[0]).text()));
      if (!range) continue;
      const start = time(range[1], range[2]);
      const end = time(range[3], range[4]);
      if (!start || !end || start >= end) continue;
      row.slice(1).forEach((cell, index) => {
        const wd = header[index + 1];
        const activity = normalize($(cell).text());
        // Рядом с датой сохраняем день недели: таблица повторяется каждую
        // неделю, её дата сама сдвигается на +7 при смене дня, и сравнивать
        // такие сеансы между проверками нужно по дню недели, а не по дате.
        if (wd >= 0 && activity) sessions.push({ date: nextDateForWeekday(today, wd), weekday: wd, start, end, activity });
      });
    }
  });
  return sessions;
}

function weekdaysFromGroup(group) {
  const days = (String(group).match(WEEKDAY_ONE_RE) || []).map(weekday).filter(day => day >= 0);
  if (days.length !== 2 || !WEEKDAY_SPAN_RE.test(group)) return [...new Set(days)];
  // «Понедельник- Пятница» — диапазон, а не пара: разворачиваем его по кругу
  // недели, чтобы пережить и «Суббота-Воскресенье».
  const span = [];
  for (let day = days[0]; ; day = (day + 1) % 7) {
    span.push(day);
    if (day === days[1]) break;
  }
  return span;
}

function sessionsFromWeekdayRanges(text, today) {
  const groups = [];
  let match;
  WEEKDAY_GROUP_RE.lastIndex = 0;
  while ((match = WEEKDAY_GROUP_RE.exec(text))) {
    groups.push({ index: match.index, end: WEEKDAY_GROUP_RE.lastIndex, days: weekdaysFromGroup(match[0]) });
  }
  const sessions = [];
  for (let i = 0; i < groups.length; i++) {
    if (!groups[i].days.length) continue;
    const to = i + 1 < groups.length ? groups[i + 1].index : text.length;
    const chunk = text.slice(groups[i].end, to);
    const service = SERVICE_TEXT_RE.exec(chunk);
    const scope = service ? chunk.slice(0, service.index) : chunk;
    let cursor = 0;
    for (const slot of scope.matchAll(SLOT_RE)) {
      if (slot.index > cursor + WEEKLY_SLOT_GAP) break;
      cursor = slot.index + slot[0].length;
      const start = time(slot[1], slot[2]);
      const end = time(slot[3], slot[4]);
      if (!start || !end || start >= end) continue;
      const activity = normalize(/^\s*\(([^)]{1,140})\)/.exec(scope.slice(cursor))?.[1]);
      // Как и у таблиц, рядом с датой держим день недели: расписание недельное,
      // и между проверками такие сеансы сравниваются именно по нему.
      for (const day of groups[i].days) {
        sessions.push({ date: nextDateForWeekday(today, day), weekday: day, start, end, activity });
      }
    }
  }
  return sessions;
}

// Недельный сеанс знает только ближайшую свою дату. Повторяем его вперёд до
// горизонта разбора, иначе листание карточки упиралось бы в пустые дни.
function expandWeekly(sessions, today) {
  const horizon = addDays(today, WEEKLY_HORIZON_DAYS);
  return sessions.flatMap(session => {
    if (session.weekday === undefined) return [session];
    const repeats = [];
    for (let date = session.date; date <= horizon; date = addDays(date, 7)) repeats.push({ ...session, date });
    return repeats;
  });
}

function closureNotice(text) {
  const temporary = /(?:платные\s+)?услуги\s+временно\s+не\s+оказываются[^.!]*[.!]*/i.exec(text);
  if (temporary) return normalize(temporary[0]).slice(0, 220);
  const hit = /(закрыт(?:а|о|ы)?|не\s+работает|ремонт|отключени[ея]\s+воды|услуги\s+временно\s+не\s+оказываются)/i.exec(text);
  if (!hit) return null;
  const from = Math.max(0, text.lastIndexOf('.', hit.index) + 1);
  const until = text.indexOf('.', hit.index);
  return normalize(text.slice(from, until < 0 ? hit.index + 180 : until + 1)).slice(0, 220);
}

function unique(sessions) {
  const seen = new Set();
  return sessions.filter(item => {
    const key = `${item.date}|${item.start}|${item.end}|${item.activity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

async function loadFacility(facility, today) {
  try {
    const html = await fetchHtml(facility.sourceUrl);
    const { $, root, text: pageText } = contentText(html);
    const text = stripExcludedSections(pageText);
    const inline = sessionsFromInline(text, today);
    const table = inline.length >= 2 ? [] : sessionsFromTables($, root, today);
    // Последняя попытка — дни недели словами: так свёрстана страница гребной
    // базы. Пускаем её только вхолостую, чтобы не спорить с двумя разборами выше.
    const weekly = inline.length || table.length ? [] : sessionsFromWeekdayRanges(text, today);
    const defaults = { ice_arena: 'Массовое катание', sports_pool: 'Свободное плавание', rowing_base: 'Тренажёрный зал' };
    const sessions = unique(expandWeekly([...inline, ...table, ...weekly], today)).map(session => ({
      ...session,
      activity: session.activity || defaults[facility.id] || '',
    }));
    // Время удачного разбора: по нему карточка понимает, насколько стары
    // данные, если следующая попытка прочитать страницу сорвётся.
    const checkedAt = new Date().toISOString();
    const dayNotes = dayNotesFromInline(text, today);
    if (sessions.length || dayNotes.length) return { ...facility, status: 'ok', sessions, dayNotes, checkedAt };
    // Причину простоя объект называет сам («закрыт на ремонт») — пересказывать
    // её своими словами нельзя: страница малого бассейна годом раньше молчала,
    // и заготовка «пока не опубликовано» пережила саму причину.
    const notice = closureNotice(text);
    if (notice) return { ...facility, status: 'closed', notice, sessions: [], checkedAt };
    return { ...facility, status: 'unavailable', sessions: [] };
  } catch (error) {
    console.warn(`[schedule] ${facility.id}:`, error.message);
    return { ...facility, status: 'unavailable', sessions: [] };
  }
}

// Страница, которая не прочиталась (таймаут, ошибка сервера, пустой разбор),
// не должна стирать объект из карточки: подставляем его последние удачные
// данные, пока им меньше суток, с пометкой stale. Описание объекта берём
// свежее — оно из кода, а не с сайта.
function withLastGood(payload, stored, now = Date.now()) {
  const previous = new Map((stored?.facilities || []).map(facility => [facility.id, facility]));
  return {
    ...payload,
    facilities: payload.facilities.map(facility => {
      if (facility.status !== 'unavailable') return facility;
      const last = previous.get(facility.id);
      if (!last || last.status === 'unavailable' || !(now - Date.parse(last.checkedAt) < LAST_GOOD_MS)) return facility;
      return { ...facility, status: last.status, notice: last.notice, sessions: last.sessions, dayNotes: last.dayNotes, checkedAt: last.checkedAt, stale: true };
    }),
  };
}

// store необязателен: без него расписание читается с сайта. С ним свежий
// результат последней проверки берётся из Redis, а новый — сохраняется туда
// же, чтобы им пользовались остальные инстансы. Redis спрашиваем раньше
// памяти инстанса: он общий, и проверка QStash могла обновить его минуту назад.
// Память остаётся запасным уровнем на случай, когда Redis не ответил.
async function getSchedule({ force = false, store = null } = {}) {
  const today = todayIso();
  const stored = store ? await store.getPayload().catch(() => null) : null;
  if (!force) {
    if (stored?.today === today && Date.now() - Date.parse(stored.generatedAt) < STORED_FRESH_MS) return stored;
    if (cache && cache.payload.today === today && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  }
  const facilities = await Promise.all(FACILITIES.map(facility => loadFacility(facility, today)));
  const payload = withLastGood({ today, generatedAt: new Date().toISOString(), facilities }, stored);
  if (store) await store.savePayload(payload).catch(error => console.warn('[schedule] payload not stored:', error.message));
  cache = { at: Date.now(), payload };
  return payload;
}

module.exports = { FACILITIES, TZ, addDays, currentTime, dayNotesFromInline, getSchedule, stripExcludedSections, todayIso, sessionsFromInline, sessionsFromTables, sessionsFromWeekdayRanges, withLastGood };
