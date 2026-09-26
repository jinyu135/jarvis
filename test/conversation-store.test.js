'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveTitle,
  messagesFromThread,
  normalizeStoredConversations,
  normalizeThreadList,
  restoreMessagesForThread
} = require('../src/conversation-store');

test('local conversation records stay separate and preserve legacy beta history', () => {
  const serialized = JSON.stringify({
    threadId: 'thread-a',
    messages: [{ id: 'a1', role: 'user', text: '기존 대화' }],
    conversations: {
      'thread-b': { title: '두 번째', messages: [{ id: 'b1', role: 'assistant', text: '다른 대화' }], updatedAt: 10 }
    }
  });
  const saved = normalizeStoredConversations(JSON.parse(serialized));

  assert.deepEqual(saved['thread-a'].messages.map((message) => message.text), ['기존 대화']);
  assert.deepEqual(saved['thread-b'].messages.map((message) => message.text), ['다른 대화']);
  assert.deepEqual(restoreMessagesForThread('thread-a', saved).map((message) => message.text), ['기존 대화']);
  assert.deepEqual(restoreMessagesForThread('thread-b', saved).map((message) => message.text), ['다른 대화']);
  assert.equal(saved['thread-a'].title, '기존 대화');
  assert.equal(saved['thread-b'].title, '두 번째');
});

test('thread list normalizes App Server titles and Unix timestamps', () => {
  const [thread] = normalizeThreadList({ data: [{
    id: 'thread-1', name: '회의 정리', preview: '회의 후속 정리', updatedAt: 1730831111
  }] });
  assert.equal(thread.title, '회의 정리');
  assert.equal(thread.updatedAt, 1730831111000);
});

test('thread read turns restore user and assistant messages in order', () => {
  const messages = messagesFromThread({ thread: { turns: [{ id: 'turn-1', items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '안녕' }] },
    { id: 'tool-1', type: 'mcpToolCall', arguments: '{}' },
    { id: 'assistant-1', type: 'agentMessage', text: '안녕하세요.' }
  ] }] } });
  assert.deepEqual(messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '안녕' },
    { role: 'assistant', text: '안녕하세요.' }
  ]);
  assert.equal(deriveTitle(messages), '안녕');
});
