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

// Объект, на котором открыта карточка. Всё, чего нет в текущем списке объектов,
// становится «Все»: иначе кнопки карточки унесут неизвестный id в callback_data,
// маршрутизация его не примет, и карточка перестанет отвечать целиком — включая
// /start, который прочитал бы тот же id и собрал такую же нерабочую карточку.
function normalizeView(view) {
  return typeof view === 'string' && ALL_FACILITY_IDS.includes(view) ? view : 'all';
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
  isSubscribed,
  normalizeSubscription,
  normalizeView,
  setSubscription,
  subscribedChanges,
  toggleSubscription,
};
