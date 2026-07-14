const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshDashboards } = require('../lib/daily-refresh');

test('daily refresh edits cards, ignores unchanged ones and removes unavailable chats', async () => {
  const removed = [];
  const store = {
    list: async () => [
      { chatId: '1', messageId: 10 },
      { chatId: '2', messageId: 20 },
      { chatId: '3', messageId: 30 },
    ],
    remove: async chatId => removed.push(chatId),
  };
  const result = await refreshDashboards({
    store,
    html: '<b>schedule</b>',
    replyMarkup: { inline_keyboard: [] },
    edit: async chatId => {
      if (chatId === '2') throw new Error('Bad Request: message is not modified');
      if (chatId === '3') throw new Error('Forbidden: bot was blocked by the user');
    },
  });

  assert.deepEqual(result, { total: 3, updated: 1, unchanged: 1, removed: 1, failed: 0 });
  assert.deepEqual(removed, ['3']);
});
