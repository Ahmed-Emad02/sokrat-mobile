/**
 * PBX Internal Chat — shared TypeScript types.
 * Snake_case mirrors the PBX JSON API.
 */

export type MessageType = 'text' | 'attachment' | 'contact';

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  kind?: string;
  url?: string; // resolved download URL
}

export interface ChatMessage {
  id: string;
  client_id?: string;
  conversation_id: string;
  sender_extension: string;
  type: MessageType;
  body: string;
  attachment_ids?: string[];
  attachments?: ChatAttachment[];
  created_at: string; // ISO timestamp
  read_at?: string;
  // Local state only (never from server)
  pending?: boolean;
  failed?: boolean;
  uploadProgress?: number; // 0–1
}

export interface ChatConversation {
  id: string;
  extension: string;      // the remote party
  name?: string;          // resolved display name
  last_message?: ChatMessage;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

export interface UnreadSummary {
  total: number;
  // per conversation id
  per_conversation: Record<string, number>;
}

export interface PbxExtension {
  extension: string;
  name: string;
}

// FCM push payload for chat messages (type = 'chat-message')
export interface ChatPushPayload {
  type: 'chat-message';
  conversationId: string;
  messageId: string;
  senderExtension: string;
  extension: string; // target extension (ours)
  preview?: string;
  timestamp?: string;
}
