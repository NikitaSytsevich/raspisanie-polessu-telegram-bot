const { addDays, FACILITIES, TZ } = require('./schedule');
const { ALL_FACILITY_IDS, encodeView, isSubscribed, normalizeView, toggleView } = require('./subscriptions');

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

// Кнопка, которая перерисовала бы ту же самую карточку, приходит выключенной:
// Telegram по ней не присылает callback, и лишний editMessageText не уходит.
// disabled — это тип кнопки, поэтому callback_data у неё быть не может: «exactly
// one of the fields other than text, icon_custom_emoji_id, and style must be
// used». Точку у выбранного объекта оставляем — она читается и там, где
// выключенная кнопка внешне не отличается от обычной.
function inactive(text) {
  return { text, disabled: {} };
}

// Три ряда, по одному вопросу на ряд: когда — что — настройки. Объекты
// подписаны эмодзи: пять кнопок влезают в один ряд, а названия выбранных
// объектов всё равно стоят в карточке.
//
// Объекты — метки, а не переключатель: выбранные подсвечены (style: primary)
// и отмечены галочкой — она читается и там, где клиент не красит кнопки. Каждая
// кнопка несёт в callback_data уже готовый итоговый набор, поэтому обработчику
// не нужно помнить, что было выбрано до нажатия.
function navKeyboard(date, today, view = null) {
  const shown = normalizeView(view);
  const token = encodeView(shown);
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  const facilityButton = facility => {
    const label = facility.emoji || facility.name;
    const on = Boolean(shown?.includes(facility.id));
    return {
      text: on ? `✓${label}` : label,
      callback_data: `f:${encodeView(toggleView(shown, facility.id))}:${date}`,
      ...(on ? { style: 'primary' } : {}),
    };
  };
  return {
    inline_keyboard: [
      [
        { text: `‹ ${dateLabel(previous, true)}`, callback_data: `d:${previous}:${token}` },
        date === today ? inactive('Сегодня') : { text: 'Сегодня', callback_data: `d:${today}:${token}` },
        { text: `${dateLabel(next, true)} ›`, callback_data: `d:${next}:${token}` },
      ],
      [
        shown ? { text: 'Все', callback_data: `f:0:${date}` } : inactive('• Все'),
        ...FACILITIES.map(facilityButton),
      ],
      [
        { text: '🔔 Уведомления', callback_data: `n:menu:${date}:${token}` },
        { text: '↻ Обновить', callback_data: `r:${date}:${token}` },
      ],
    ],
  };
}

function cleanNotice(notice) {
  // Тексты сайта приходят с кричащими «!!!» на конце — в карточке они лишние.
  return String(notice || '').replace(/\s*!+\s*$/, '');
}

function minskLabel(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

// Страница объекта не прочиталась, и карточка показывает его последние удачные
// данные: говорим об этом прямо и называем, от какого они часа.
function staleNote(facility) {
  const checkedAt = new Date(facility.checkedAt);
  if (!facility.stale || Number.isNaN(checkedAt.getTime())) return '';
  return ` — ⚠️ сайт не ответил, данные на ${minskLabel(checkedAt)}`;
}

function facilityBlock(facility, sessions) {
  // Не используем <table>: на iOS ряды таблиц Rich Messages с переносами
  // текста наезжают друг на друга, а сама таблица занимает пол-экрана.
  // Сеансы завёрнуты в <blockquote>: полоска слева визуально группирует блок.
  const heading = `${emojiPrefix(facility.id)}<b><a href="${escapeHtml(facility.sourceUrl)}">${escapeHtml(facility.name)}</a></b>${escapeHtml(staleNote(facility))}`;
  if (facility.status === 'closed') return `<p>${heading} — ⛔ ${escapeHtml(cleanNotice(facility.notice) || 'сейчас закрыт')}</p>`;
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
  return `<footer>Обновлено <tg-time unix="${unix}" format="dt">${minskLabel(date)}</tg-time></footer>`;
}

// Заголовок карточки: один объект — полным названием, несколько — эмодзи:
// названия и так стоят над каждым блоком, а заголовок должен влезать в строку.
function viewTitle(chosen) {
  if (!chosen.length) return 'Все объекты';
  if (chosen.length === 1) return `${emojiPrefix(chosen[0].id)}${chosen[0].name}`;
  return chosen.map(facility => EMOJI_BY_ID.get(facility.id) || facility.name).join(' ');
}

function formatDay(payload, date, view = null) {
  const shown = normalizeView(view);
  const chosen = shown ? payload.facilities.filter(facility => shown.includes(facility.id)) : [];
  const blocks = [`<h3>${escapeHtml(viewTitle(chosen))} · ${dateLabel(date)}</h3>`];
  const facilities = chosen.length ? chosen : payload.facilities;
  for (const facility of facilities) {
    blocks.push(facilityBlock(facility, facility.sessions.filter(session => session.date === date)));
  }
  blocks.push(updatedFooter(payload.generatedAt));
  return blocks.join('');
}

// Карточка чата целиком: и текст, и клавиатура зависят от выбранного объекта,
// поэтому фоновые обновления собирают её тем же кодом, что и нажатие кнопки.
function cardView(payload, dashboard) {
  const view = normalizeView(dashboard?.view);
  return {
    html: formatDay(payload, payload.today, view),
    replyMarkup: navKeyboard(payload.today, payload.today, view),
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

function notificationsKeyboard(subscribed, date, view = null) {
  const token = encodeView(view);
  const rows = FACILITIES.map(facility => [{
    text: `${isSubscribed(subscribed, facility.id) ? '✅' : '⬜️'} ${emojiPrefix(facility.id)}${facility.name}`,
    callback_data: `n:${facility.id}:${date}:${token}`,
  }]);
  const anyOn = ALL_FACILITY_IDS.some(id => isSubscribed(subscribed, id));
  rows.push([{
    text: anyOn ? '🔕 Выключить все' : '🔔 Включить все',
    callback_data: `n:${anyOn ? 'off' : 'all'}:${date}:${token}`,
  }]);
  rows.push([{ text: '‹ К расписанию', callback_data: `d:${date}:${token}` }]);
  return { inline_keyboard: rows };
}

// Кнопка под сообщением об изменениях: по нажатию сообщение удаляется,
// чтобы акцент в чате оставался на основной карточке.
const ACK_KEYBOARD = { inline_keyboard: [[{ text: '✓ Ознакомлен', callback_data: 'ack' }]] };

module.exports = {
  ACK_KEYBOARD,
  cardView,
  cleanNotice,
  dateLabel,
  emojiPrefix,
  escapeHtml,
  formatDay,
  formatNotifications,
  navKeyboard,
  notificationsKeyboard,
};
