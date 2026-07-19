function isRemovedDashboardError(error) {
  return /(chat not found|bot was blocked by the user|user is deactivated|message to edit not found)/i.test(String(error?.message || error));
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

async function refreshDashboards({ store, html, replyMarkup, edit, dashboards }) {
  const list = dashboards || await store.list();
  const results = { total: list.length, updated: 0, unchanged: 0, removed: 0, failed: 0 };
  await inBatches(list, async dashboard => {
    try {
      await edit(dashboard.chatId, dashboard.messageId, html, replyMarkup);
      results.updated += 1;
    } catch (error) {
      if (isUnchangedMessageError(error)) {
        results.unchanged += 1;
      } else if (isRemovedDashboardError(error)) {
        await store.remove(dashboard.chatId);
        results.removed += 1;
      } else {
        console.error(`[daily-refresh] ${dashboard.chatId}:`, error.message);
        results.failed += 1;
      }
    }
  });
  return results;
}

module.exports = { refreshDashboards, isRemovedDashboardError, isUnchangedMessageError, inBatches };
