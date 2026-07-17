const { addDays } = require('./schedule');

const TZ = 'Europe/Minsk';
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const FACILITY_EMOJI = { ice_arena: '⛸', sports_pool: '🏊', small_pool: '🌊', rowing_base: '🚣' };

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dateLabel(iso, short = false) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (short) return `${WEEKDAYS[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

const FACILITY_BUTTONS = [
  ['all', 'Все'],
  ['ice_arena', 'Лёд'],
  ['sports_pool', 'Большой'],
  ['small_pool', 'Малый'],
  ['rowing_base', 'Гребная'],
];

function navKeyboard(date, today, selected = 'all') {
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  return {
    inline_keyboard: [
      [
        { text: `‹ ${dateLabel(previous, true)}`, callback_data: `d:${previous}:${selected}` },
        { text: 'Сегодня', callback_data: `d:${today}:${selected}` },
        { text: `${dateLabel(next, true)} ›`, callback_data: `d:${next}:${selected}` },
      ],
      FACILITY_BUTTONS.slice(0, 3).map(([id, label]) => ({
        text: id === selected ? `• ${label}` : label,
        callback_data: `f:${id}:${date}`,
      })),
      FACILITY_BUTTONS.slice(3).map(([id, label]) => ({
        text: id === selected ? `• ${label}` : label,
        callback_data: `f:${id}:${date}`,
      })),
      [{ text: '↻ Обновить', callback_data: `r:${date}:${selected}` }, { text: 'Источники', callback_data: `s:${date}:${selected}` }],
    ],
  };
}

function facilityBlock(facility, sessions) {
  // Не используем <table>: на iOS ряды таблиц Rich Messages с переносами
  // текста наезжают друг на друга, а сама таблица занимает пол-экрана.
  // Строка «время — занятие» с моноширинным временем читается компактнее.
  const emoji = FACILITY_EMOJI[facility.id] ? `${FACILITY_EMOJI[facility.id]} ` : '';
  const heading = `${emoji}<b><a href="${escapeHtml(facility.sourceUrl)}">${escapeHtml(facility.name)}</a></b>`;
  if (facility.status === 'closed') return `<p>${heading}<br />⛔ Сейчас закрыт${facility.notice ? ` — ${escapeHtml(facility.notice)}` : ''}</p>`;
  if (facility.status === 'not_published') return `<p>${heading}<br />🕓 Расписание пока не опубликовано.</p>`;
  if (facility.status !== 'ok') return `<p>${heading}<br />Данные временно недоступны. Откройте страницу объекта позже.</p>`;
  if (!sessions.length) return `<p>${heading}<br />Сеансов на эту дату нет.</p>`;
  const rows = sessions.map(session => `<code>${session.start}–${session.end}</code>  ${escapeHtml(session.activity || 'Свободное посещение')}`);
  return `<p>${heading}<br />${rows.join('<br />')}</p>`;
}

function updatedFooter(generatedAt) {
  const date = generatedAt ? new Date(generatedAt) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const unix = Math.floor(date.getTime() / 1000);
  // Запасной текст внутри tg-time показывается, если клиент не поддерживает
  // date-time сущности; сам тег рендерится в часовом поясе читателя.
  const label = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
  return `<footer>Обновлено <tg-time unix="${unix}" format="dt">${label}</tg-time></footer>`;
}

function formatDay(payload, date, selected = 'all') {
  const selectedFacility = payload.facilities.find(facility => facility.id === selected);
  const title = selectedFacility
    ? `${FACILITY_EMOJI[selectedFacility.id] ? `${FACILITY_EMOJI[selectedFacility.id]} ` : ''}${selectedFacility.name}`
    : 'Все объекты';
  const blocks = [`<h3>${escapeHtml(title)} · ${dateLabel(date)}</h3>`];
  const facilities = selectedFacility ? [selectedFacility] : payload.facilities;
  for (const facility of facilities) {
    blocks.push(facilityBlock(facility, facility.sessions.filter(session => session.date === date)));
  }
  blocks.push(updatedFooter(payload.generatedAt));
  return blocks.join('');
}

function sourcesKeyboard(payload, date, selected = 'all') {
  const rows = payload.facilities.map(facility => [{
    text: `${FACILITY_EMOJI[facility.id] ? `${FACILITY_EMOJI[facility.id]} ` : ''}${facility.name}`,
    url: facility.sourceUrl,
  }]);
  rows.push([{ text: '‹ К расписанию', callback_data: `d:${date}:${selected}` }]);
  return { inline_keyboard: rows };
}

const SOURCES = '<h3>Источники</h3><p>Расписание загружается с официальных страниц ПолесГУ. Если данные не совпадают, ориентируйтесь на страницу объекта: она обновляется университетом.</p>';

module.exports = { SOURCES, formatDay, navKeyboard, sourcesKeyboard };
