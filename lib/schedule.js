const cheerio = require('cheerio');

const TZ = 'Europe/Minsk';
const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 90_000;

const FACILITIES = [
  ['ice_arena', 'Ледовая арена', 'https://www.polessu.by/%D0%BB%D0%B5%D0%B4%D0%BE%D0%B2%D0%B0%D1%8F-%D0%B0%D1%80%D0%B5%D0%BD%D0%B0-%D0%BF%D0%BE%D0%BB%D0%B5%D1%81%D0%B3%D1%83'],
  ['sports_pool', 'Большой бассейн', 'https://www.polessu.by/%D0%B1%D0%BE%D0%BB%D1%8C%D1%88%D0%BE%D0%B9-%D0%B1%D0%B0%D1%81%D1%81%D0%B5%D0%B9%D0%BD'],
  ['small_pool', 'Малый бассейн', 'https://www.polessu.by/%D0%BC%D0%B0%D0%BB%D1%8B%D0%B9-%D0%B1%D0%B0%D1%81%D1%81%D0%B5%D0%B9%D0%BD'],
  ['rowing_base', 'Гребная база', 'https://www.polessu.by/%D1%80%D0%B0%D1%81%D0%BF%D0%B8%D1%81%D0%B0%D0%BD%D0%B8%D0%B5-%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D1%8B-%D1%82%D1%80%D0%B5%D0%BD%D0%B0%D0%B6%D0%B5%D1%80%D0%BD%D0%BE%D0%B3%D0%BE-%D0%B7%D0%B0%D0%BB%D0%B0-%D0%B8-%D0%B7%D0%B0%D0%BB%D0%B0-%D1%88%D1%82%D0%B0%D0%BD%D0%B3%D0%B8-%D0%B3%D1%80%D0%B5%D0%B1%D0%BD%D0%B0%D1%8F-%D0%B1%D0%B0%D0%B7%D0%B0-%E2%84%961'],
].map(([id, name, sourceUrl]) => ({ id, name, sourceUrl }));

const WEEKDAYS = [
  ['воскресенье', 0], ['понедельник', 1], ['вторник', 2], ['среда', 3],
  ['четверг', 4], ['пятница', 5], ['суббота', 6],
];
const DAY_RE = /(?:понедельник|вторник|сред[ауы]|четверг|пятниц[аы]|суббот[аы]|воскресень[еяю])/giu;
const DATE_DAY_RE = /(?:понедельник|вторник|сред[ауы]|четверг|пятниц[аы]|суббот[аы]|воскресень[еяю])\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/giu;
const SLOT_RE = /(\d{1,2})[.:](\d{2})\s*[–—-]\s*(\d{1,2})[.:](\d{2})/g;
// Для одиночного поиска с группами часов и минут: String.match с глобальным
// регулярным выражением возвращает только полные совпадения без групп.
const SINGLE_SLOT_RE = new RegExp(SLOT_RE.source);

let cache = null;

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
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
  return found ? found[1] : -1;
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
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 3 * 1024 * 1024) throw new Error('response too large');
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
  // Cheerio сохраняет пробелы и переносы из исходной Drupal-разметки;
  // normalise ниже превращает их в единый разделитель, не склеивая слоты.
  return { $, root, text: normalize(root.text()) };
}

function sessionsFromInline(text, today) {
  const anchors = [];
  let match;
  DATE_DAY_RE.lastIndex = 0;
  while ((match = DATE_DAY_RE.exec(text))) {
    anchors.push({ index: match.index, end: DATE_DAY_RE.lastIndex, date: `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` });
  }
  const sessions = [];
  for (let i = 0; i < anchors.length; i++) {
    const from = anchors[i].end;
    const to = i + 1 < anchors.length ? anchors[i + 1].index : text.length;
    const chunk = text.slice(from, to);
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
      const activity = /^\s*\(([^)]{1,140})\)/.exec(after)?.[1] || '';
      sessions.push({ date: anchors[i].date, start, end, activity });
    }
  }
  return sessions.filter(s => s.date >= addDays(today, -7) && s.date <= addDays(today, 45));
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
        if (wd >= 0 && activity) sessions.push({ date: nextDateForWeekday(today, wd), start, end, activity });
      });
    }
  });
  return sessions;
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
    const { $, root, text } = contentText(html);
    const inline = sessionsFromInline(text, today);
    const table = inline.length >= 2 ? [] : sessionsFromTables($, root, today);
    const defaults = { ice_arena: 'Массовое катание', sports_pool: 'Свободное плавание' };
    const sessions = unique([...inline, ...table]).map(session => ({
      ...session,
      activity: session.activity || defaults[facility.id] || '',
    }));
    if (sessions.length) return { ...facility, status: 'ok', sessions };
    const notice = closureNotice(text);
    if (facility.id === 'small_pool') {
      return {
        ...facility,
        status: 'not_published',
        notice: 'На официальной странице пока не опубликованы сеансы.',
        sessions: [],
      };
    }
    return { ...facility, status: notice ? 'closed' : 'unavailable', notice, sessions: [] };
  } catch (error) {
    console.warn(`[schedule] ${facility.id}:`, error.message);
    return { ...facility, status: 'unavailable', sessions: [] };
  }
}

async function getSchedule({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  const today = todayIso();
  const facilities = await Promise.all(FACILITIES.map(facility => loadFacility(facility, today)));
  const payload = { today, generatedAt: new Date().toISOString(), facilities };
  cache = { at: Date.now(), payload };
  return payload;
}

module.exports = { FACILITIES, addDays, getSchedule, todayIso, sessionsFromInline, sessionsFromTables };
