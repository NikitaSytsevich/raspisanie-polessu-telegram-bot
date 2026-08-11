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

function toggleSubscription(subscribed, id) {
  const current = subscribed || ALL_FACILITY_IDS;
  return normalizeSubscription(current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
}

function subscribedChanges(changes, subscribed) {
  return subscribed ? changes.filter(change => isSubscribed(subscribed, change.facility.id)) : changes;
}

module.exports = { ALL_FACILITY_IDS, isSubscribed, normalizeSubscription, subscribedChanges, toggleSubscription };
