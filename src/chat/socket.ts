/**
 * Socket.IO client for live PBX chat updates.
 *
 * Connection: gateway /api/gateway/chat/socket.io, namespace /chat
 *   auth: { token: <pbx chat token> }
 *   query: { ticket: <gateway ticket> }
 *
 * Falls back to polling if the gateway ticket endpoint is unavailable (e.g.
 * gateway not yet upgraded), connecting directly with token-only auth.
 */
import { io, Socket } from 'socket.io-client';
import type { ChatClient } from './client';
import type { ChatMessage, ChatConversation } from './types';

export interface TypingEvent {
  conversationId: string;
  extension: string;
  isTyping: boolean;
}

export interface ChatSocketHandlers {
  onMessage: (msg: ChatMessage) => void;
  onConversationUpdated: (conv: ChatConversation) => void;
  onTyping: (data: TypingEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
}

export class ChatSocket {
  private socket: Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly gatewayBase: string,
    private readonly client: ChatClient,
    private readonly handlers: ChatSocketHandlers,
  ) {}

  async connect(): Promise<void> {
    if (this.disposed) return;
    this.disconnect();

    let token: string;
    try {
      token = await this.client.ensureToken();
    } catch {
      console.warn('[chat-socket] could not get PBX token; retry scheduled');
      this.scheduleReconnect();
      return;
    }

    let ticketQuery: Record<string, string> = {};
    try {
      const ticketRes = await this.client.getChatTicket();
      ticketQuery = { ticket: ticketRes.ticket };
    } catch {
      // Gateway ticket endpoint not yet available; connect without it
      console.warn('[chat-socket] ticket endpoint unavailable; connecting without ticket');
    }

    const socket = io(`${this.gatewayBase}/chat`, {
      path: '/api/gateway/chat/socket.io',
      transports: ['websocket'],
      auth: { token },
      query: ticketQuery,
      reconnection: false, // manual reconnect with backoff
      timeout: 15_000,
    });

    socket.on('connect', () => {
      console.log('[chat-socket] connected');
      this.handlers.onConnected();
    });

    socket.on('disconnect', (reason) => {
      console.log('[chat-socket] disconnected:', reason);
      this.handlers.onDisconnected();
      if (!this.disposed) this.scheduleReconnect();
    });

    socket.on('connect_error', (err) => {
      console.warn('[chat-socket] connect_error:', err.message);
      if (!this.disposed) this.scheduleReconnect();
    });

    socket.on('chat:message', (payload: { conversation_id?: number | string; message?: unknown }) => {
      const msg = this.client.normalizeMessage(payload?.message);
      if (msg.id && msg.conversation_id) { this.handlers.onMessage(msg); this.messageListeners.forEach(fn => fn(msg)); }
    });
    socket.on('chat:conversation', (payload: { conversation?: unknown }) => {
      const conv = this.client.normalizeConversation(payload?.conversation);
      if (conv.id) this.handlers.onConversationUpdated(conv);
    });
    socket.on('chat:typing', (payload: { conversation_id?: number | string; extension?: string; typing?: boolean }) => {
      if (payload?.conversation_id && payload.extension) {
        const event = { conversationId: String(payload.conversation_id), extension: String(payload.extension), isTyping: Boolean(payload.typing) };
        this.handlers.onTyping(event); this.typingListeners.forEach(fn => fn(event));
      }
    });

    this.socket = socket;
  }

  private readonly messageListeners = new Set<(msg: ChatMessage) => void>();
  private readonly typingListeners = new Set<(data: TypingEvent) => void>();

  onMessage(listener: (msg: ChatMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onTyping(listener: (data: TypingEvent) => void): () => void {
    this.typingListeners.add(listener);
    return () => this.typingListeners.delete(listener);
  }

  sendTyping(conversationId: string, isTyping: boolean): void {
    this.socket?.emit('chat:typing', { conversation_id: Number(conversationId), typing: isTyping });
  }

  disconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }

  private scheduleReconnect(delayMs = 8_000): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) void this.connect();
    }, delayMs);
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }
}
