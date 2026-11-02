/**
 * REST client for the PBX extension-chat API.
 *
 * All requests are proxied through the gateway:
 *   /api/extension-chat/v1/*
 *
 * Authentication:
 *  1. Device: X-Sokrat-Device + Authorization Bearer claimSecret
 *  2. PBX HMAC: HMAC-SHA256(sipPassword, extension\ntimestamp\nMETHOD\noriginalUrl)
 *
 * The PBX chat token (from /session) is cached and refreshed on 401.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import { joinUrl } from '../gateway/urls';
import type { ChatConversation, ChatMessage, ChatAttachment, PbxExtension, UnreadSummary } from './types';

const CHAT_TIMEOUT_MS = 12_000;

/** HMAC-SHA256 hex of sipPassword over the canonical chat signing message. */
export function buildChatHmac(
  sipPassword: string,
  extension: string,
  timestamp: string,
  method: string,
  originalUrl: string,
): string {
  const message = `${extension}\n${timestamp}\n${method.toUpperCase()}\n${originalUrl}`;
  const sig = hmac(sha256, utf8ToBytes(sipPassword), utf8ToBytes(message));
  return bytesToHex(sig);
}

export interface ChatClientOptions {
  /** Gateway base URL — session.apiURL or getPushGateway(account.serverHost). */
  gatewayBase: string;
  claimSecret: string;
  deviceId: string;
  extension: string;
  sipPassword: string;
  /** Optional injected fetch for tests. */
  fetcher?: typeof fetch;
}

export class ChatClient {
  private readonly opts: ChatClientOptions;
  private token: string | null = null;
  private tokenPromise: Promise<string> | null = null;
  private readonly fetch: typeof fetch;

  constructor(opts: ChatClientOptions) {
    this.opts = opts;
    this.fetch = opts.fetcher ?? globalThis.fetch;
  }

  // ---- Token management ----

  private async refreshToken(): Promise<string> {
    const res = await this.rawRequest('POST', '/api/extension-chat/v1/session', undefined, false);
    const json: unknown = await res.json();
    if (!json || typeof json !== 'object' || !('token' in json) || typeof (json as Record<string, unknown>).token !== 'string') {
      throw new Error('[chat] session token missing');
    }
    const tok = (json as { token: string }).token;
    this.token = tok;
    return tok;
  }

  private getToken(): Promise<string> {
    if (this.token) return Promise.resolve(this.token);
    this.tokenPromise ??= this.refreshToken().finally(() => { this.tokenPromise = null; });
    return this.tokenPromise;
  }

  // ---- Request helpers ----

  private deviceHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.claimSecret}`,
      'X-Sokrat-Device': this.opts.deviceId,
    };
  }

  private hmacHeaders(method: string, path: string): Record<string, string> {
    const timestamp = String(Date.now());
    return {
      'X-Sokrat-Extension': this.opts.extension,
      'X-Sokrat-Timestamp': timestamp,
      'X-Sokrat-Signature': buildChatHmac(this.opts.sipPassword, this.opts.extension, timestamp, method, path),
    };
  }

  private async rawRequest(method: string, path: string, body?: unknown, withToken = true): Promise<Response> {
    const url = joinUrl(this.opts.gatewayBase, path);
    const headers: Record<string, string> = {
      ...this.deviceHeaders(),
      ...this.hmacHeaders(method, path),
      'Content-Type': 'application/json',
    };
    if (withToken) {
      headers['X-Chat-Token'] = await this.getToken();
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    try {
      return await this.fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch a path, refreshing token once on 401. Returns parsed JSON. */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res = await this.rawRequest(method, path, body);
    if (res.status === 401) {
      this.token = null;
      res = await this.rawRequest(method, path, body);
    }
    if (!res.ok) throw new Error(`[chat] ${method} ${path} → HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }


  private normalizeAttachment(raw: any): ChatAttachment {
    return {
      id: String(raw?.id ?? ''),
      name: String(raw?.original_name ?? raw?.name ?? 'attachment'),
      size: Number(raw?.size_bytes ?? raw?.size ?? 0),
      mime_type: String(raw?.mime ?? raw?.mime_type ?? 'application/octet-stream'),
      kind: raw?.kind ? String(raw.kind) : undefined,
    };
  }

  normalizeMessage(raw: any): ChatMessage {
    return {
      id: String(raw?.id ?? ''),
      client_id: raw?.client_id ? String(raw.client_id) : undefined,
      conversation_id: String(raw?.conversation_id ?? ''),
      sender_extension: String(raw?.sender_extension ?? ''),
      type: raw?.type === 'attachment' || raw?.type === 'contact' ? raw.type : 'text',
      body: String(raw?.body ?? ''),
      attachments: Array.isArray(raw?.attachments)
        ? raw.attachments.map((item: any) => this.normalizeAttachment(item))
        : undefined,
      created_at: String(raw?.created_at ?? new Date().toISOString()),
    };
  }

  normalizeConversation(raw: any): ChatConversation {
    const participants = Array.isArray(raw?.participants) ? raw.participants : [];
    const remote = participants.find((item: any) => String(item?.extension || '') !== this.opts.extension);
    const last = raw?.last_message ? this.normalizeMessage(raw.last_message) : undefined;
    return {
      id: String(raw?.id ?? ''),
      extension: String(remote?.extension ?? raw?.extension ?? ''),
      name: String(raw?.name ?? raw?.title ?? remote?.extension ?? ''),
      last_message: last,
      unread_count: Number(raw?.unread ?? 0),
      created_at: String(raw?.created_at ?? ''),
      updated_at: String(raw?.updated_at ?? raw?.last_message_at ?? ''),
    };
  }

  // ---- Public PBX chat API ----

  async getConversations(): Promise<ChatConversation[]> {
    const json = await this.call<{ conversations?: ChatConversation[] }>('GET', '/api/extension-chat/v1/conversations');
    return Array.isArray(json?.conversations) ? json.conversations.map((raw: any) => this.normalizeConversation(raw)) : [];
  }

  async getMessages(conversationId: string, limit = 50, before?: string): Promise<ChatMessage[]> {
    let path = `/api/extension-chat/v1/conversations/${conversationId}/messages?limit=${limit}`;
    if (before) path += `&before=${encodeURIComponent(before)}`;
    const json = await this.call<{ messages?: ChatMessage[] }>('GET', path);
    return Array.isArray(json?.messages) ? json.messages.map((raw: any) => this.normalizeMessage(raw)) : [];
  }

  async createConversation(extension: string): Promise<ChatConversation> {
    const json = await this.call<{ conversation?: ChatConversation }>('POST', '/api/extension-chat/v1/conversations', { extension });
    if (!json?.conversation) throw new Error('[chat] createConversation: no conversation returned');
    return this.normalizeConversation(json.conversation);
  }

  async markRead(conversationId: string, messageId: string): Promise<void> {
    await this.call('POST', `/api/extension-chat/v1/conversations/${conversationId}/read`, { message_id: messageId });
  }

  async getUnread(): Promise<UnreadSummary> {
    const json = await this.call<{ total?: number; conversations?: Array<{ conversation_id?: string | number; unread?: number }> }>('GET', '/api/extension-chat/v1/unread');
    const per_conversation: Record<string, number> = {};
    for (const row of Array.isArray(json?.conversations) ? json.conversations : []) {
      if (row?.conversation_id !== undefined) per_conversation[String(row.conversation_id)] = Number(row.unread ?? 0);
    }
    return {
      total: typeof json?.total === 'number' ? json.total : 0,
      per_conversation,
    };
  }

  async getExtensions(): Promise<PbxExtension[]> {
    const json = await this.call<{ extensions?: PbxExtension[] }>('GET', '/api/extension-chat/v1/extensions');
    return Array.isArray(json?.extensions) ? json.extensions : [];
  }

  async sendText(conversationId: string, body: string, clientId: string): Promise<ChatMessage> {
    const json = await this.call<{ message?: ChatMessage }>(
      'POST',
      `/api/extension-chat/v1/conversations/${conversationId}/messages`,
      { type: 'text', body, client_id: clientId },
    );
    if (!json?.message) throw new Error('[chat] sendText: no message returned');
    return this.normalizeMessage(json.message);
  }

  async sendAttachment(conversationId: string, body: string, clientId: string, attachmentIds: string[]): Promise<ChatMessage> {
    const json = await this.call<{ message?: ChatMessage }>(
      'POST',
      `/api/extension-chat/v1/conversations/${conversationId}/messages`,
      { type: 'attachment', body, client_id: clientId, attachment_ids: attachmentIds },
    );
    if (!json?.message) throw new Error('[chat] sendAttachment: no message returned');
    return this.normalizeMessage(json.message);
  }

  /**
   * Multipart upload via XHR (supports progress events).
   * Field name is 'file' as required by the PBX API.
   */
  async uploadAttachment(
    fileUri: string,
    fileName: string,
    mimeType: string,
    onProgress?: (fraction: number) => void,
  ): Promise<ChatAttachment> {
    const path = '/api/extension-chat/v1/attachments';
    const url = joinUrl(this.opts.gatewayBase, path);
    const tok = await this.getToken();
    const timestamp = String(Date.now());
    const sig = buildChatHmac(this.opts.sipPassword, this.opts.extension, timestamp, 'POST', path);

    const formData = new FormData();
    // RN FormData accepts {uri, name, type} as the file part value
    formData.append('file', { uri: fileUri, name: fileName, type: mimeType } as unknown as Blob);

    return new Promise<ChatAttachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${this.opts.claimSecret}`);
    xhr.setRequestHeader('X-Sokrat-Device', this.opts.deviceId);
    xhr.setRequestHeader('X-Sokrat-Extension', this.opts.extension);
    xhr.setRequestHeader('X-Sokrat-Timestamp', timestamp);
    xhr.setRequestHeader('X-Sokrat-Signature', sig);
    xhr.setRequestHeader('X-Chat-Token', tok);
    xhr.timeout = 120_000;
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json: unknown = JSON.parse(xhr.responseText);
          if (json && typeof json === 'object' && 'attachment' in json) {
            resolve(this.normalizeAttachment((json as { attachment: any }).attachment));
          } else {
            reject(new Error('[chat] upload: no attachment in response'));
          }
        } catch {
          reject(new Error('[chat] upload: invalid JSON'));
        }
      } else {
        reject(new Error(`[chat] upload: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('[chat] upload: network error'));
    xhr.ontimeout = () => reject(new Error('[chat] upload: timeout'));
      xhr.send(formData);
    });
  }

  /** POST /api/gateway/chat-ticket — Socket.IO auth ticket. */
  async getChatTicket(): Promise<{ ticket: string; expiresIn: number }> {
    const path = '/api/gateway/chat-ticket';
    const url = joinUrl(this.opts.gatewayBase, path);
    const headers: Record<string, string> = {
      ...this.deviceHeaders(),
      ...this.hmacHeaders('POST', path),
      'Content-Type': 'application/json',
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, { method: 'POST', headers, signal: ctrl.signal });
      if (!res.ok) throw new Error(`[chat] chat-ticket HTTP ${res.status}`);
      return res.json() as Promise<{ ticket: string; expiresIn: number }>;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Authenticated URL + headers for an attachment render/download. */
  attachmentRequest(attachmentId: string): { url: string; headers: Record<string, string> } {
    const path = `/api/extension-chat/v1/attachments/${encodeURIComponent(attachmentId)}`;
    return {
      url: joinUrl(this.opts.gatewayBase, path),
      headers: { ...this.deviceHeaders(), ...this.hmacHeaders('GET', path) },
    };
  }

  invalidateToken(): void { this.token = null; }

  /** Ensure the session token is fresh and return it (used by socket). */
  ensureToken(): Promise<string> { return this.getToken(); }
}
