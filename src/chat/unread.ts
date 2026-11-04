/**
 * Socket and push transports may echo a message sent by this account.
 * Those echoes must update the cached thread, but never create an unread
 * badge for the sender's own message.
 */
export function shouldIncrementChatUnread(senderExtension: string, ownExtension: string): boolean {
  return Boolean(senderExtension) && senderExtension !== ownExtension;
}
