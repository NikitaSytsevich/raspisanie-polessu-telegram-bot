const { addDays } = require('./schedule');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dateLabel(iso, short = false) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (short) return `${WEEKDAYS[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function navKeyboard(date, today) {
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  return {
    inline_keyboard: [
      [
        { text: `‹ ${dateLabel(previous, true)}`, callback_data: `d:${previous}` },
        { text: 'Сегодня', callback_data: `d:${today}` },
        { text: `${dateLabel(next, true)} ›`, callback_data: `d:${next}` },
      ],
      [{ text: 'Неделя', callback_data: 'w' }, { text: 'Обновить', callback_data: `r:${date}` }],
    ],
  };
}

function facilityTable(facility, sessions) {
  const heading = `<h4><a href="${escapeHtml(facility.sourceUrl)}">${escapeHtml(facility.name)}</a></h4>`;
  if (facility.status === 'closed') return `${heading}<p>⛔ Сейчас закрыт${facility.notice ? ` — ${escapeHtml(facility.notice)}` : ''}</p>`;
  if (facility.status !== 'ok') return `${heading}<p>Данные временно недоступны. Откройте страницу объекта позже.</p>`;
  if (!sessions.length) return `${heading}<p>Сеансов на эту дату нет.</p>`;
  const rows = sessions.map(session => `<tr><td><code>${session.start}–${session.end}</code></td><td>${escapeHtml(session.activity || 'Свободное посещение')}</td></tr>`).join('');
  return `${heading}<table bordered striped><tr><th>Время</th><th>Что проходит</th></tr>${rows}</table>`;
}

function formatDay(payload, date) {
  const blocks = [`<h3>Расписание · ${dateLabel(date)}</h3>`];
  for (const facility of payload.facilities) {
    blocks.push(facilityTable(facility, facility.sessions.filter(session => session.date === date)));
  }
  return blocks.join('');
}

function formatWeek(payload) {
  const blocks = ['<h3>Расписание на неделю</h3>'];
  for (let index = 0; index < 7; index++) {
    const date = addDays(payload.today, index);
    const rows = [];
    for (const facility of payload.facilities) {
      const sessions = facility.sessions.filter(session => session.date === date);
      if (sessions.length) rows.push(`<tr><td><a href="${escapeHtml(facility.sourceUrl)}">${escapeHtml(facility.name)}</a></td><td>${sessions.map(s => `${s.start}–${s.end}`).join('<br>')}</td></tr>`);
      else if (facility.status === 'closed') rows.push(`<tr><td>${escapeHtml(facility.name)}</td><td>⛔ закрыт</td></tr>`);
    }
    const body = rows.length
      ? `<table bordered striped><tr><th>Объект</th><th>Время</th></tr>${rows.join('')}</table>`
      : '<p>Сеансов нет.</p>';
    blocks.push(`<details${index === 0 ? ' open' : ''}><summary><b>${dateLabel(date)}${index === 0 ? ' · сегодня' : ''}</b></summary>${body}</details>`);
  }
  return blocks.join('');
}

const HELP = [
  '<h3>Расписание ПолесГУ</h3>',
  '<p>Показываю расписание спортивных объектов по данным официального сайта ПолесГУ.</p>',
  '<ul><li><code>/today</code> — сегодня</li><li><code>/tomorrow</code> — завтра</li><li><code>/week</code> — ближайшие 7 дней</li></ul>',
  '<footer>Данные загружаются по запросу; уведомлений, аккаунтов и хранения данных нет.</footer>',
].join('');

module.exports = { HELP, formatDay, formatWeek, navKeyboard };
