import type { ChatMessage } from './types';

/**
 * Insert/replace a chat message without producing a duplicate when the
 * optimistic client message, the REST response, and the socket echo arrive
 * in different orders.
 */
export function mergeChatMessage(prev: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const idx = prev.findIndex((message) =>
    message.id === incoming.id ||
    (!!incoming.client_id && message.client_id === incoming.client_id),
  );
  if (idx < 0) return [...prev, incoming];
  const next = [...prev];
  next[idx] = { ...prev[idx], ...incoming };
  return next;
}
