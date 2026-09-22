const { FACILITIES } = require('./schedule');

// Подписка на уведомления хранится списком id объектов. null означает «все»:
// так же читаются чаты, заведённые до появления настроек, и так же
// автоматически подхватываются новые объекты, если их добавят в парсер.
const ALL_FACILITY_IDS = FACILITIES.map(facility => facility.id);

function isSubscribed(subscribed, id) {
  return subscribed ? subscribed.includes(id) : true;
}

function normalizeSubscription(ids) {
  const kept = ALL_FACILITY_IDS.filter(id => ids.includes(id));
  return kept.length === ALL_FACILITY_IDS.length ? null : kept;
}

// Объекты, которые показывает карточка: null — все, иначе непустой список id в
// порядке FACILITIES. Полный и пустой наборы сворачиваются в null, как и у
// подписки. Строку принимаем ради записей прошлой версии, где объект был один.
// Всё, чего нет в текущем списке объектов, отбрасывается: иначе кнопки карточки
// унесли бы неизвестный id в callback_data, и карточка перестала бы отвечать.
function normalizeView(view) {
  const ids = typeof view === 'string' ? [view] : Array.isArray(view) ? view : [];
  const kept = ALL_FACILITY_IDS.filter(id => ids.includes(id));
  return kept.length && kept.length < ALL_FACILITY_IDS.length ? kept : null;
}

// Метки объектов в ряду карточки. Из «Все» первое нажатие оставляет один объект —
// так карточкой пользуются чаще всего, — следующие добавляют и убирают объекты.
function toggleView(view, id) {
  if (!view) return normalizeView([id]);
  return normalizeView(view.includes(id) ? view.filter(item => item !== id) : [...view, id]);
}

// В callback_data набор едет битовой маской по индексу объекта в FACILITIES:
// одна hex-цифра вместо списка id, которому не хватило бы 64 байт. 0 — все.
function encodeView(view) {
  const mask = (normalizeView(view) || []).reduce((bits, id) => bits | (1 << ALL_FACILITY_IDS.indexOf(id)), 0);
  return mask.toString(16);
}

function decodeView(token) {
  if (/^[0-9a-f]{1,2}$/.test(token)) {
    const mask = parseInt(token, 16);
    return normalizeView(ALL_FACILITY_IDS.filter((_, index) => mask & (1 << index)));
  }
  // Кнопки прошлой версии несут id одного объекта или «all».
  return normalizeView(token);
}

function toggleSubscription(subscribed, id) {
  const current = subscribed || ALL_FACILITY_IDS;
  return normalizeSubscription(current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
}

// Единственное место, где живут обе формы записи: null — все объекты, [] —
// уведомления выключены. Обработчик просит действие по имени и не собирает
// значения сам, иначе смена формата подписки чинилась бы в двух файлах.
function setSubscription(subscribed, action) {
  if (action === 'all') return null;
  if (action === 'off') return [];
  return toggleSubscription(subscribed, action);
}

function subscribedChanges(changes, subscribed) {
  return changes.filter(change => isSubscribed(subscribed, change.facility.id));
}

module.exports = {
  ALL_FACILITY_IDS,
  decodeView,
  encodeView,
  isSubscribed,
  normalizeSubscription,
  normalizeView,
  setSubscription,
  subscribedChanges,
  toggleSubscription,
  toggleView,
};
