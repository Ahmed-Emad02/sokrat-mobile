/**
 * AsyncStorage cache for chat conversations and messages.
 * Scoped per account: `${extension}@${serverHost}`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatConversation, ChatMessage, UnreadSummary } from './types';

const MAX_CACHED_MESSAGES = 100;

function scopeKey(scope: string, suffix: string): string {
  return `@sokrat/chat/${scope}/${suffix}`;
}

export class ChatCache {
  private readonly scope: string;

  constructor(extension: string, serverHost: string) {
    // e.g. "160@pbx.example.com"
    this.scope = `${extension}@${serverHost}`;
  }

  // ---- Conversations ----

  async getConversations(): Promise<ChatConversation[]> {
    try {
      const raw = await AsyncStorage.getItem(scopeKey(this.scope, 'conversations'));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ChatConversation[]) : [];
    } catch {
      return [];
    }
  }

  async saveConversations(list: ChatConversation[]): Promise<void> {
    await AsyncStorage.setItem(scopeKey(this.scope, 'conversations'), JSON.stringify(list));
  }

  async upsertConversation(conv: ChatConversation): Promise<void> {
    const existing = await this.getConversations();
    const idx = existing.findIndex(c => c.id === conv.id);
    if (idx >= 0) {
      existing[idx] = conv;
    } else {
      existing.unshift(conv);
    }
    await this.saveConversations(existing);
  }

  // ---- Messages ----

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    try {
      const raw = await AsyncStorage.getItem(scopeKey(this.scope, `msgs/${conversationId}`));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    } catch {
      return [];
    }
  }

  async saveMessages(conversationId: string, messages: ChatMessage[]): Promise<void> {
    // Keep only the newest MAX_CACHED_MESSAGES
    const trimmed = messages.slice(-MAX_CACHED_MESSAGES);
    await AsyncStorage.setItem(scopeKey(this.scope, `msgs/${conversationId}`), JSON.stringify(trimmed));
  }

  /** Append or replace a message by id. */
  async upsertMessage(conversationId: string, msg: ChatMessage): Promise<void> {
    const existing = await this.getMessages(conversationId);
    const idx = existing.findIndex(m => m.id === msg.id || (msg.client_id && m.client_id === msg.client_id));
    if (idx >= 0) {
      existing[idx] = msg;
    } else {
      existing.push(msg);
    }
    await this.saveMessages(conversationId, existing);
  }

  // ---- Unread ----

  async getUnread(): Promise<UnreadSummary> {
    try {
      const raw = await AsyncStorage.getItem(scopeKey(this.scope, 'unread'));
      if (!raw) return { total: 0, per_conversation: {} };
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'total' in parsed) {
        return parsed as UnreadSummary;
      }
      return { total: 0, per_conversation: {} };
    } catch {
      return { total: 0, per_conversation: {} };
    }
  }

  async saveUnread(summary: UnreadSummary): Promise<void> {
    await AsyncStorage.setItem(scopeKey(this.scope, 'unread'), JSON.stringify(summary));
  }

  /** Decrement unread for a conversation after reading. */
  async markConversationRead(conversationId: string): Promise<UnreadSummary> {
    const current = await this.getUnread();
    const prev = current.per_conversation[conversationId] ?? 0;
    const next: UnreadSummary = {
      total: Math.max(0, current.total - prev),
      per_conversation: { ...current.per_conversation, [conversationId]: 0 },
    };
    await this.saveUnread(next);
    return next;
  }

  /** Increment unread for a conversation (from push/socket). */
  async incrementUnread(conversationId: string): Promise<UnreadSummary> {
    const current = await this.getUnread();
    const prev = current.per_conversation[conversationId] ?? 0;
    const next: UnreadSummary = {
      total: current.total + 1,
      per_conversation: { ...current.per_conversation, [conversationId]: prev + 1 },
    };
    await this.saveUnread(next);
    return next;
  }

  // ---- Lifecycle ----

  /** Remove all cache entries for this account scope. */
  async clear(): Promise<void> {
    try {
      const allKeys = (await AsyncStorage.getAllKeys()) as unknown as string[];
      const prefix = `@sokrat/chat/${this.scope}/`;
      const ours = allKeys.filter(k => k.startsWith(prefix));
      if (ours.length) await (AsyncStorage as unknown as { multiRemove(keys: string[]): Promise<void> }).multiRemove(ours);
    } catch {}
  }
}
