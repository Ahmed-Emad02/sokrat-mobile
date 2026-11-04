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
  // Server-normalized messages do not carry the local pending/failed flags.
  // Clear them when a confirmed message replaces an optimistic one; otherwise
  // the sending spinner or Retry control survives a successful send.
  const confirmed = incoming.pending !== true && incoming.failed !== true;
  next[idx] = {
    ...prev[idx],
    ...incoming,
    ...(confirmed ? { pending: false, failed: false } : {}),
  };
  return next;
}
