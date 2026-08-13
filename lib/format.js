const { addDays, FACILITIES, TZ } = require('./schedule');
const { ALL_FACILITY_IDS, isSubscribed } = require('./subscriptions');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
// Ищем по id, а не по объекту: сообщение об изменениях строится по снимку
// расписания, и там от объекта остаются только сравниваемые поля.
const EMOJI_BY_ID = new Map(FACILITIES.map(facility => [facility.id, facility.emoji]));

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function emojiPrefix(id) {
  const emoji = EMOJI_BY_ID.get(id);
  return emoji ? `${emoji} ` : '';
}

function dateLabel(iso, short = false) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (short) return `${WEEKDAYS[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

// Три ряда, по одному вопросу на ряд: когда — что — настройки. Объекты
// подписаны эмодзи: пять кнопок влезают в один ряд, а название выбранного
// объекта всё равно стоит в заголовке карточки.
function navKeyboard(date, today, selected = 'all') {
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  const mark = id => (id === selected ? '• ' : '');
  return {
    inline_keyboard: [
      [
        { text: `‹ ${dateLabel(previous, true)}`, callback_data: `d:${previous}:${selected}` },
        { text: 'Сегодня', callback_data: `d:${today}:${selected}` },
        { text: `${dateLabel(next, true)} ›`, callback_data: `d:${next}:${selected}` },
      ],
      [
        { text: `${mark('all')}Все`, callback_data: `f:all:${date}` },
        ...FACILITIES.map(facility => ({
          text: `${mark(facility.id)}${facility.emoji || facility.name}`,
          callback_data: `f:${facility.id}:${date}`,
        })),
      ],
      [
        { text: '🔔 Уведомления', callback_data: `n:menu:${date}:${selected}` },
        { text: '↻ Обновить', callback_data: `r:${date}:${selected}` },
      ],
    ],
  };
}

function cleanNotice(notice) {
  // Тексты сайта приходят с кричащими «!!!» на конце — в карточке они лишние.
  return String(notice || '').replace(/\s*!+\s*$/, '');
}

function facilityBlock(facility, sessions) {
  // Не используем <table>: на iOS ряды таблиц Rich Messages с переносами
  // текста наезжают друг на друга, а сама таблица занимает пол-экрана.
  // Сеансы завёрнуты в <blockquote>: полоска слева визуально группирует блок.
  const heading = `${emojiPrefix(facility.id)}<b><a href="${escapeHtml(facility.sourceUrl)}">${escapeHtml(facility.name)}</a></b>`;
  if (facility.status === 'closed') return `<p>${heading} — ⛔ ${escapeHtml(cleanNotice(facility.notice) || 'сейчас закрыт')}</p>`;
  if (facility.status === 'not_published') return `<p>${heading} — 🕓 пока не опубликовано</p>`;
  if (facility.status !== 'ok') return `<p>${heading} — данные временно недоступны, откройте страницу объекта</p>`;
  if (!sessions.length) return `<p>${heading} — сеансов на эту дату нет</p>`;
  const rows = sessions.map(session => `<b>${session.start}–${session.end}</b> · ${escapeHtml(session.activity || 'Свободное посещение')}`);
  return `<p>${heading}</p><blockquote>${rows.join('<br />')}</blockquote>`;
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
  const title = selectedFacility ? `${emojiPrefix(selectedFacility.id)}${selectedFacility.name}` : 'Все объекты';
  const blocks = [`<h3>${escapeHtml(title)} · ${dateLabel(date)}</h3>`];
  const facilities = selectedFacility ? [selectedFacility] : payload.facilities;
  for (const facility of facilities) {
    blocks.push(facilityBlock(facility, facility.sessions.filter(session => session.date === date)));
  }
  blocks.push(updatedFooter(payload.generatedAt));
  return blocks.join('');
}

// Карточка чата целиком: и текст, и клавиатура зависят от выбранного объекта,
// поэтому фоновые обновления собирают её тем же кодом, что и нажатие кнопки.
function cardView(payload, dashboard) {
  const selected = dashboard?.view || 'all';
  return {
    html: formatDay(payload, payload.today, selected),
    replyMarkup: navKeyboard(payload.today, payload.today, selected),
  };
}

function subscriptionLine(subscribed) {
  if (!subscribed) return 'Сейчас: сообщаю обо всех объектах.';
  if (!subscribed.length) return 'Сейчас: уведомления выключены.';
  const names = FACILITIES.filter(facility => subscribed.includes(facility.id))
    .map(facility => `${emojiPrefix(facility.id)}${facility.name}`);
  return `Сейчас: ${names.join(', ')}.`;
}

function formatNotifications(subscribed) {
  return '<h3>🔔 Уведомления об изменениях</h3>'
    + '<p>Отметьте объекты, о которых стоит писать. Об остальных бот промолчит — в расписании они останутся.</p>'
    + `<blockquote>${escapeHtml(subscriptionLine(subscribed))}</blockquote>`;
}

function notificationsKeyboard(subscribed, date, selected = 'all') {
  const rows = FACILITIES.map(facility => [{
    text: `${isSubscribed(subscribed, facility.id) ? '✅' : '⬜️'} ${emojiPrefix(facility.id)}${facility.name}`,
    callback_data: `n:${facility.id}:${date}:${selected}`,
  }]);
  const anyOn = ALL_FACILITY_IDS.some(id => isSubscribed(subscribed, id));
  rows.push([{
    text: anyOn ? '🔕 Выключить все' : '🔔 Включить все',
    callback_data: `n:${anyOn ? 'off' : 'all'}:${date}:${selected}`,
  }]);
  rows.push([{ text: '‹ К расписанию', callback_data: `d:${date}:${selected}` }]);
  return { inline_keyboard: rows };
}

// Кнопка под сообщением об изменениях: по нажатию сообщение удаляется,
// чтобы акцент в чате оставался на основной карточке.
const ACK_KEYBOARD = { inline_keyboard: [[{ text: '✓ Ознакомлен', callback_data: 'ack' }]] };

module.exports = {
  ACK_KEYBOARD,
  cardView,
  emojiPrefix,
  escapeHtml,
  formatDay,
  formatNotifications,
  navKeyboard,
  notificationsKeyboard,
};
