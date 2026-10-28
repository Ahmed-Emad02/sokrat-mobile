# Sokrat Mobile — Internal Chat Implementation Plan

- **Status:** Proposed; no code implemented yet.
- **Date:** 2026-10-25
- **Target repository:** `apps/sokrat-mobile-main`
- **Reference implementations:**
  - Desktop: `sokrat-voice-desktop` (`47a0242`) — full chat UI, attachments, contact sharing, downloads, call actions.
  - Chrome extension: `sokrat-chrome-extension` (`882e19e`) — popup and side-panel chat, v1.11.0 package.
  - Server: `sokrat-voip` (`0f485d3`) — extension chat REST + Socket.IO backend, live on the test PBX.
- **API contract:** `/opt/sokrat-voip-chat/docs/CHAT_API.md` on the PBX worktree.

> Before starting: `sokrat-mobile-main` currently has uncommitted telephony/UI changes.
> Commit or stash them, or create a dedicated `feature/mobile-chat` worktree, so chat
> work does not mix with the active changes.

---

## 1. Objective

Bring the same internal extension chat to the mobile app:

- Text conversations with live Socket.IO updates.
- Conversation list with display name, `#extension ID`, unread count, and a Call button.
- Message thread with typing indicator, read state, and Arabic RTL support.
- Image attachments up to 2 MB.
- PDF/XLS/XLSX attachments up to 10 MB.
- Attachment previews, downloads, and native open/share.
- Contact sharing from extensions, saved contacts, and the PBX address book.
- Background chat notifications via FCM/APNs.
- Per-account cache, logout cleanup, and reconnect handling.

The PBX chat backend already exists and is live. Phases 1–4 require **no new backend
work**. Background push notifications in Phase 5 require a small push-gateway
extension.

---

## 2. Guiding decisions

- Keep the existing app architecture; do **not** add React Navigation or Redux.
- Add Chat as a fourth bottom tab: **Phone | Contacts | Chat | Favourites**.
- The server is the source of truth. Cache is only for fast rendering/offline display.
- Reuse the desktop/Chrome HMAC auth and Socket.IO contract.
- Use pure-JS crypto (`@noble/hashes`) rather than a native crypto dependency.
- Keep chat independent of SIP registration, but use the active SIP credentials for
  HMAC signing (same as desktop/Chrome).
- Never store attachment binaries in AsyncStorage.
- Every chat cache is scoped to `${extension}@${serverHost}`.
- Foreground chat works without push. Background notifications are a separate phase.
- Call actions from chat reuse the existing `onCall`/`handleOutboundCall` path.
- Preserve all existing telephony behavior; chat must not interfere with calls,
  CallKeep, audio routing, or the native incoming-call UI.

---

## 3. Architecture

```text
App.tsx
  └─ account loaded / changed / logged out
       └─ ChatService.configure(account) / dispose()
            ├─ HMAC REST  → PBX /api/extension-chat/v1
            ├─ Socket.IO  → PBX /chat
            ├─ AsyncStorage cache
            └─ state snapshots
                 └─ ChatProvider / useChat
                      └─ ChatTab
                           ├─ ConversationList
                           └─ ChatThread
```

### Data flow

1. `App.tsx` loads `SavedAccount` and configures `ChatService`.
2. `ChatService` signs REST requests with HMAC and opens the chat Socket.IO connection.
3. Incoming socket events update the service state and AsyncStorage cache.
4. `ChatProvider` exposes snapshots to the chat UI.
5. UI actions call typed service methods (send, read, typing, upload, download, share).
6. On logout/account change, the service disconnects and the cache is cleared or
   re-scoped.

### New modules

```text
src/chat/
  ChatService.ts        Singleton connection, REST, socket, token refresh, lifecycle
  chatTypes.ts          Conversation, Message, Attachment, Contact types
  chatApi.ts            HMAC signing + REST request helpers
  chatCache.ts          Per-account AsyncStorage cache
  attachments.ts        Pick, validate, upload, download, open/share
  ChatContext.tsx       Provider + useChat hook around ChatService
  pushChat.ts           Chat push payload normalization/deep-link intent

src/ui/
  ChatTab.tsx
  ChatConversationRow.tsx
  ChatThread.tsx
  ChatComposer.tsx
  ChatContactCard.tsx
  ChatDirectoryModal.tsx
  ChatAttachment.tsx
```

### Files to modify

- `App.tsx`
  - Configure/dispose `ChatService` on login, logout, and account changes.
  - Reconnect chat when the app returns to the foreground.
  - Handle a pending chat deep link from a notification.
- `src/ui/StandardPhoneScreen.tsx`
  - Add `'chat'` to `BottomTab`.
  - Add the fourth bottom navigation item and unread badge.
  - Refactor the hard-coded 3-tab indicator math and swipe order to use a tab array.
    The current implementation hard-codes `SCREEN_WIDTH / 3` and 3-item order arrays
    in multiple places.
  - Render `ChatTab` and pass `onCall`, contacts, account, and chat state.
- `src/i18n.ts`
  - Chat strings, RTL labels, notification labels.
- `src/ui/Icons.tsx`
  - Chat, paperclip, send, download, share, message icons.
- `src/storage/store.ts`
  - Chat cache keys/helpers, or keep cache logic in `src/chat/chatCache.ts`.
- `package.json`
  - New dependencies.

---

## 4. Dependencies

| Package | Purpose | Notes |
| :--- | :--- | :--- |
| `socket.io-client` | Chat realtime transport | Same protocol/version family as desktop/Chrome |
| `@noble/hashes` | HMAC-SHA256 | Pure JS, Hermes-compatible, no native build |
| `@react-native-documents/picker` | Pick images/PDF/XLS/XLSX | Uses Android SAF / iOS document picker |
| `react-native-blob-util` | Authenticated downloads | Supports request headers and save-to-cache |
| `react-native-file-viewer` | Open downloaded PDF/Excel | Native file association |

Optional later:

- `react-native-image-picker` for camera capture.
- `@notifee/react-native` only if richer local notification control is needed beyond
  FCM/APNs payloads.

All native dependencies require a fresh Android/iOS build, not just a Metro reload.

---

## 5. API and auth contract

### REST base

```text
http://<serverHost>:8080/api/extension-chat/v1
```

### HMAC headers

```text
X-Sokrat-Extension: <extension>
X-Sokrat-Timestamp: <epoch-ms>
X-Sokrat-Signature: <hex hmac-sha256>
```

Canonical string:

```text
<extension>\n<timestamp>\n<METHOD>\n<path-with-query>
```

### Required endpoints

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `POST` | `/session` | Exchange HMAC credentials for a short-lived socket token |
| `GET` | `/conversations` | Conversation list |
| `POST` | `/conversations` | Create/find a 1:1 conversation |
| `GET` | `/conversations/:id/messages?limit=200` | Message history |
| `POST` | `/conversations/:id/messages` | Send text/attachment/contact |
| `POST` | `/conversations/:id/read` | Mark read |
| `GET` | `/unread` | Unread totals/rollups |
| `GET` | `/extensions` | Extension roster and display names |
| `POST` | `/attachments` | Multipart upload |
| `GET` | `/attachments/:id` | Authenticated attachment download |

### Socket.IO

- Namespace: `/chat`
- URL: `http://<serverHost>:8080/chat`
- Auth: `{ token }`
- Transport: `websocket`
- Events:
  - `chat:message`
  - `chat:read`
  - `chat:conversation`
  - `chat:typing`

Token TTL is 10 minutes. Refresh every 8 minutes. On `unauthorized`, request a fresh
token and reconnect.

---

## 6. Data model

```ts
interface ChatAttachment {
  id: number;
  original_name: string;
  mime: string;
  size_bytes: number;
  kind: 'image' | 'pdf' | 'excel';
}

interface ChatMessage {
  id: number;
  conversation_id: number;
  sender_extension: string;
  type: 'text' | 'attachment' | 'contact' | 'system';
  body: string;
  metadata?: any;
  attachments: ChatAttachment[];
  created_at: string;
}

interface ChatConversation {
  id: number;
  participants: Array<{ extension: string; role?: string }>;
  last_message?: Partial<ChatMessage> | null;
  last_message_at?: string;
  unread?: number;
}

interface ChatContact {
  name: string;
  phone?: string;
  extension?: string;
  company?: string;
}
```

Display names are resolved from `/extensions`. If no display name exists, fall back
to the extension number. The UI always shows `#<extension>` separately.

---

## 7. Phases

### Phase 0 — Preparation

1. Resolve the dirty mobile worktree and create `feature/mobile-chat`.
2. Confirm the target PBX has the chat API.
3. Add dependencies and verify the Android build.
4. Add a `CHAT_ENABLED` feature flag so the tab can be hidden during development.
5. Add chat strings to `src/i18n.ts` early so Arabic/English are first-class.

**Done when:** the app builds and all existing telephony tests pass with the new
dependencies installed.

---

### Phase 1 — Chat transport, auth, and cache

Implement `ChatService` and `chatApi`:

- HMAC signing with `@noble/hashes`.
- Session token exchange.
- Socket.IO connect/reconnect with token refresh.
- REST calls for conversations, messages, unread, extensions.
- Per-account AsyncStorage cache.
- Cache limits: last 200 messages per conversation, max 50 conversations.
- Clear cache on logout; re-scope on account switch.
- Reconnect on app foreground and network restoration.
- Do not store attachment binary data in AsyncStorage.

**Done when:** the app can list conversations, load messages, send text, and receive
live messages while open.

---

### Phase 2 — Chat tab and conversation list

Add the fourth bottom tab:

```text
Phone | Contacts | Chat | Favourites
```

Refactor the tab animation/indicator/swipe code so it is driven by an array rather
than hard-coded `3`.

Conversation row:

- Initial avatar.
- **Display name in a larger bold font.**
- **`#extension` below the name in a smaller mono/dim style.**
- Last-message preview.
- Time.
- Unread badge.
- **Call button for 1:1 conversations.**

Behavior:

- Tap row → open thread.
- Tap Call → existing `onCall(extension)` path; must not open the thread.
- Search filters display name, extension ID, and preview.
- Display names come from `/extensions`; fall back to the extension number.

**Done when:** rows show names/IDs, unread state, and call buttons, and calling from
chat enters the existing dialer/call flow.

---

### Phase 3 — Thread, composer, typing, read state

Thread:

- Header: back, display name, `#extension`, share-contact button.
- `FlatList` of messages with auto-scroll/inverted behavior.
- Own/other bubble alignment.
- Arabic RTL bubble text; use `I18nManager` and text direction handling.
- Timestamp and sender extension.
- Typing indicator.
- Mark read via `POST /conversations/:id/read`.
- Contact card and attachment rendering.

Composer:

- Auto-growing `TextInput` up to a maximum height.
- Arabic right-to-left input support.
- Attach and send buttons.
- Pending attachment pill with remove action.
- `KeyboardAvoidingView` and safe-area handling.
- Dismiss/disable keyboard during active calls or incoming-call UI.

Realtime:

- Deduplicate socket messages and REST results by message ID.
- Update unread counts.
- Mark the latest visible message read when the thread is active.
- Reload after reconnect/app resume.
- Preserve draft text across tab switches.

**Done when:** two devices exchange live text, typing appears, unread/read state is
correct, and Arabic input works.

---

### Phase 4 — Attachments, contacts, downloads, calls

Attachments:

- Validate:
  - Images: JPG/JPEG/PNG/WEBP/GIF, max 2 MB.
  - Documents: PDF/XLS/XLSX, max 10 MB.
- Copy Android `content://` selections to app cache when required.
- Upload with `FormData` and HMAC headers.
- Download images with authenticated headers to cache and render from `file://`.
- Download documents to cache, then open with native viewer.
- Show an explicit download icon on every file/image attachment.
- Add Share where useful.
- Show upload progress / “Uploading…” state.

Contact sharing:

- Merge:
  - Internal extensions from `/extensions`.
  - Saved mobile contacts.
  - PBX address book from `/api/extension/v1/contacts` for phone-only contacts.
- Payload:
  ```json
  { "name": "...", "phone": "...", "extension": "..." }
  ```
- Phone-only: Call enabled, Message hidden.
- Extension: Call and Message enabled.

The current mobile `Contact` type has only `name` and `extension`. Extend it with an
optional `phone`, or introduce a separate `ChatContact` type so existing contact UI
is not disrupted.

Calls:

- Call button in list rows, contact cards, and the thread header.
- Reuse `onCall` / `handleOutboundCall`.
- Keep the existing active-call UI authoritative; chat input must not steal focus
  or interfere with audio.

**Done when:** images/PDF/Excel upload, display, download, and open; address-book
contacts can be shared; call buttons work from chat.

---

### Phase 5 — Background chat notifications

This is the only phase requiring server changes.

Backend / push gateway:

Add a chat push event after a message is persisted:

```text
POST /api/push/chat-message
{
  recipientExtension,
  senderExtension,
  senderName,
  conversationId,
  messageId,
  preview,
  unread,
  timestamp
}
```

- Push gateway looks up `mobile_devices` and sends FCM/APNs to the recipient.
- Do not send to the sender.
- Use a dedicated Android channel, e.g. `chat_messages`.
- APNs payload includes `conversationId` and `messageId`.
- Add a deep-link/intent that opens Chat and the correct conversation.
- Keep the push payload short; fetch the full message after opening.

Mobile:

- Extend `src/push/pushHandler.ts` with `msg: 'chat-message'`.
- Do not reuse the incoming-call payload path.
- Background/killed: system notification.
- Foreground: in-app toast/unread update; suppress duplicate system notification when
  the relevant thread is open.
- Notification tap: open Chat → conversation.
- Persist a pending chat deep link for cold starts.
- Reuse the existing FCM/APNs registration and notification permission.

If background push is not required for the first release, Phases 1–4 can ship with
in-app unread badges only.

**Done when:** messages received while backgrounded/killed produce a notification
that opens the correct conversation, with no duplicate foreground notifications.

---

### Phase 6 — Hardening and tests

Automated:

- HMAC canonical/signature tests.
- Session token refresh and unauthorized reconnect.
- Cache isolation across accounts and hosts.
- Message deduplication and unread/read logic.
- Attachment size/type validation.
- Socket event tests with a mocked Socket.IO client.
- Push payload normalization and deep-link tests.
- Existing Jest suite remains green.

Device testing (Android first, then iOS):

- Text send/receive, typing, unread/read.
- Conversation names, #IDs, call buttons.
- Arabic RTL layout and composer direction.
- Images, PDF, XLSX upload/preview/download/open.
- Phone-only and extension contact sharing.
- Background/foreground, network loss/reconnect.
- Incoming call while chat is open.
- Logout clears socket/cache.
- Account switch reconnects correctly.
- Small screen + keyboard behavior.
- Dark/light themes.

Regression:

- SIP registration, calls, transfer, hold, mute.
- Native incoming-call notifications and CallKeep.
- Call history and contacts.
- Existing telephony tests.

---

## 8. Suggested delivery order

1. **Phase 0–1** — service, auth, cache, text only.
2. **Phase 2–3** — Chat tab, list, thread, names/IDs/call, composer, RTL.
3. **Phase 4** — attachments, downloads, contact sharing.
4. **Phase 5** — background push notifications + server changes.
5. **Phase 6** — hardening, iOS verification, docs.

Rough effort: **2–3 developer weeks** for full parity, with push and iOS testing as
the main buffer risks.

---

## 9. Risks and mitigations

| Risk | Mitigation |
| :--- | :--- |
| Dirty mobile worktree mixes with chat work | Commit/stash or use a `feature/mobile-chat` worktree |
| Hard-coded 3-tab nav math | Refactor to a tab array before adding Chat |
| RN Hermes crypto differences | Use `@noble/hashes` with `utf8ToBytes`, avoid native crypto |
| Android `content://` uploads | Copy selected files to cache before upload |
| Large attachments / memory | Stream via blob util; never keep base64 in state/cache |
| Socket suspended in background | Foreground socket; FCM/APNs for background notifications |
| iOS build unavailable on this host | Implement/test Android first; verify iOS on macOS |
| AsyncStorage quota/security | Cache text/metadata only; cap messages; clear on logout |
| Multi-account cache leakage | Key cache by extension + host; reset on switch |
| Duplicate notifications | Suppress when the thread is active; dedupe by message ID |
| Telephony regressions | Keep chat service independent; run call tests after each phase |

---

## 10. Open decisions

1. Should background chat push be in the first release, or follow after text/attachments?
2. For contact sharing, use the PBX address book, device contacts, or both?
3. Should downloaded files open automatically, or only show download/share?
4. Confirm Chat is a fourth bottom tab: `Phone | Contacts | Chat | Favourites`.

Recommended first increment: **Phases 0–3** with text chat, list/thread, names/IDs,
call buttons, unread, RTL, and auto-grow. Then attachments/contact sharing, then push.
