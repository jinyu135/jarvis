'use strict';

const MAX_MESSAGES_PER_CONVERSATION = 200;

function plainText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('');
}

function deriveTitle(messages, fallback = '새 대화') {
  const firstUserMessage = (messages || []).find((message) => message?.role === 'user' && (message.text || message.content));
  if (!firstUserMessage) return fallback;
  const text = String(firstUserMessage.text ?? firstUserMessage.content).replace(/\s+/g, ' ').trim();
  return text.length > 56 ? `${text.slice(0, 55)}…` : text;
}

function normalizeTimestamp(value) {
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeStoredConversations(saved) {
  const result = Object.create(null);
  if (saved && typeof saved.conversations === 'object' && !Array.isArray(saved.conversations)) {
    for (const [id, value] of Object.entries(saved.conversations)) {
      if (!id || !value || typeof value !== 'object') continue;
      result[id] = {
        id,
        title: typeof value.title === 'string' ? value.title : '대화',
        messages: Array.isArray(value.messages) ? value.messages.slice(-MAX_MESSAGES_PER_CONVERSATION) : [],
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0
      };
    }
  }
  if (typeof saved?.threadId === 'string' && Array.isArray(saved.messages) && !result[saved.threadId]) {
    result[saved.threadId] = {
      id: saved.threadId,
      title: deriveTitle(saved.messages),
      messages: saved.messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
      updatedAt: Date.now()
    };
  }
  return result;
}

function normalizeThreadList(result) {
  const rows = Array.isArray(result?.data) ? result.data
    : Array.isArray(result?.threads) ? result.threads
      : Array.isArray(result?.thread?.data) ? result.thread.data : [];
  return rows.map((thread) => {
    const id = thread?.id ?? thread?.threadId;
    if (typeof id !== 'string' || !id) return null;
    const preview = typeof thread.preview === 'string' ? thread.preview : '';
    return {
      id,
      title: String(thread.name ?? thread.title ?? preview.split(/\r?\n/, 1)[0] ?? '대화').trim() || '대화',
      preview,
      updatedAt: normalizeTimestamp(thread.updatedAt ?? thread.updated_at ?? thread.createdAt)
    };
  }).filter(Boolean);
}

function messagesFromThread(result) {
  const thread = result?.thread ?? result;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages = [];
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      let role;
      let text = '';
      if (item?.type === 'userMessage') {
        role = 'user';
        text = plainText(item.content ?? item.text);
      } else if (item?.type === 'agentMessage') {
        role = 'assistant';
        text = plainText(item.content ?? item.text);
      }
      if (!role || !text.trim()) continue;
      messages.push({
        id: String(item.id ?? `${turn.id ?? 'turn'}-${messages.length}`),
        role,
        text,
        createdAt: item.createdAt ?? item.created_at ?? turn.createdAt ?? turn.created_at ?? null
      });
    }
  }
  return messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
}

function restoreMessagesForThread(threadId, conversations, threadReadResult) {
  const localMessages = conversations?.[threadId]?.messages;
  if (Array.isArray(localMessages) && localMessages.length) return localMessages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  return messagesFromThread(threadReadResult);
}

module.exports = {
  MAX_MESSAGES_PER_CONVERSATION,
  deriveTitle,
  messagesFromThread,
  normalizeTimestamp,
  restoreMessagesForThread,
  normalizeStoredConversations,
  normalizeThreadList
};
