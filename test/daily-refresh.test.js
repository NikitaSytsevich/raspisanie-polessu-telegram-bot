const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshDashboards } = require('../lib/daily-refresh');

test('daily refresh edits cards, ignores unchanged ones and removes unavailable chats', async () => {
  const removed = [];
  const edits = [];
  const store = {
    list: async () => [
      { chatId: '1', messageId: 10, view: 'ice_arena' },
      { chatId: '2', messageId: 20, view: 'all' },
      { chatId: '3', messageId: 30, view: 'all' },
    ],
    remove: async chatId => removed.push(chatId),
  };
  const result = await refreshDashboards({
    store,
    render: dashboard => ({ html: `<b>${dashboard.view}</b>`, replyMarkup: { inline_keyboard: [] } }),
    edit: async (chatId, messageId, html) => {
      edits.push([chatId, html]);
      if (chatId === '2') throw new Error('Bad Request: message is not modified');
      if (chatId === '3') throw new Error('Forbidden: bot was blocked by the user');
    },
  });

  assert.deepEqual(result, { total: 3, updated: 1, unchanged: 1, removed: 1, failed: 0 });
  assert.deepEqual(removed, ['3']);
  // Каждая карточка перерисовывается со своим фильтром объекта.
  assert.deepEqual(edits[0], ['1', '<b>ice_arena</b>']);
});
