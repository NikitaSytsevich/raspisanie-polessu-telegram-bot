const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshDashboards } = require('../lib/daily-refresh');

test('daily refresh edits cards, ignores unchanged ones and removes unavailable chats', async () => {
  const removed = [];
  const dropped = [];
  const edits = [];
  const store = {
    list: async () => [
      { chatId: '1', messageId: 10, view: ['ice_arena'] },
      { chatId: '2', messageId: 20, view: null },
      { chatId: '3', messageId: 30, view: null },
      { chatId: '4', messageId: 40, view: null },
      // Карточку этот чат удалил раньше: перерисовывать нечего.
      { chatId: '5', messageId: null, view: null },
    ],
    remove: async chatId => removed.push(chatId),
    dropCard: async chatId => dropped.push(chatId),
  };
  const result = await refreshDashboards({
    store,
    render: dashboard => ({ html: `<b>${dashboard.view}</b>`, replyMarkup: { inline_keyboard: [] } }),
    edit: async (chatId, messageId, html) => {
      edits.push([chatId, html]);
      if (chatId === '2') throw new Error('Bad Request: message is not modified');
      if (chatId === '3') throw new Error('Forbidden: bot was blocked by the user');
      if (chatId === '4') throw new Error('Bad Request: message to edit not found');
    },
  });

  assert.deepEqual(result, { total: 4, updated: 1, unchanged: 1, removed: 1, cardsLost: 1, failed: 0 });
  // Заблокировавший бота чат забывается целиком, а удаливший карточку теряет
  // только её: подписка на уведомления у него остаётся.
  assert.deepEqual(removed, ['3']);
  assert.deepEqual(dropped, ['4']);
  assert.ok(!edits.some(([chatId]) => chatId === '5'));
  // Каждая карточка перерисовывается со своим фильтром объекта.
  assert.deepEqual(edits[0], ['1', '<b>ice_arena</b>']);
});
