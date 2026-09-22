// Чата больше нет для бота: пользователь его заблокировал или удалил аккаунт.
// Такой чат забываем целиком.
function isChatGoneError(error) {
  return /(chat not found|bot was blocked by the user|user is deactivated)/i.test(String(error?.message || error));
}

// Пропала только карточка — пользователь удалил сообщение. Бота он при этом
// не блокировал, и подписку на уведомления терять не должен.
function isCardGoneError(error) {
  return /message to edit not found/i.test(String(error?.message || error));
}

// Telegram ограничивает бота ~30 сообщениями в секунду: шлём пачками, а не
// одним Promise.all на всех — иначе при росте аудитории посыплются 429.
async function inBatches(items, handler, size = 25) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(handler));
  }
}

function isUnchangedMessageError(error) {
  return /message is not modified/i.test(String(error?.message || error));
}

// render получает запись чата целиком: карточки отличаются выбранными
// объектами, поэтому разметку собираем отдельно для каждой.
async function refreshDashboards({ store, render, edit, dashboards }) {
  // Чаты без карточки остаются в списке ради уведомлений — перерисовывать там нечего.
  const list = (dashboards || await store.list()).filter(dashboard => dashboard.messageId);
  const results = { total: list.length, updated: 0, unchanged: 0, removed: 0, cardsLost: 0, failed: 0 };
  await inBatches(list, async dashboard => {
    try {
      const { html, replyMarkup } = render(dashboard);
      await edit(dashboard.chatId, dashboard.messageId, html, replyMarkup);
      results.updated += 1;
    } catch (error) {
      if (isUnchangedMessageError(error)) {
        results.unchanged += 1;
      } else if (isChatGoneError(error)) {
        await store.remove(dashboard.chatId);
        results.removed += 1;
      } else if (isCardGoneError(error)) {
        await store.dropCard(dashboard.chatId);
        results.cardsLost += 1;
      } else {
        console.error(`[daily-refresh] ${dashboard.chatId}:`, error.message);
        results.failed += 1;
      }
    }
  });
  return results;
}

module.exports = { refreshDashboards, isCardGoneError, isChatGoneError, isUnchangedMessageError, inBatches };
