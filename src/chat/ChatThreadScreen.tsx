/**
 * Chat thread screen — message bubbles, composer, attachments, typing indicator.
 *
 * Rendered as an overlay inside StandardPhoneScreen when a conversation is open.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Animated,
  Clipboard,
  Modal,
  Image,
  Linking,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { pick, types } from '@react-native-documents/picker';
import Sound from 'react-native-nitro-sound';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  BackIcon,
  CloseIcon,
  DoubleCheckIcon,
  FileIcon,
  MicIcon,
  PaperclipIcon,
  PhoneIcon,
  SendIcon,
  StopIcon,
} from '../ui/Icons';

import { useTheme } from '../theme';
import type { ChatMessage, ChatConversation, ChatAttachment } from './types';
import type { ChatClient } from './client';
import type { ChatCache } from './cache';
import type { ChatSocket } from './socket';
import { validateAttachment } from './attachments';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function clientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface BubbleProps {
  msg: ChatMessage;
  ownExtension: string;
  client: ChatClient;
  onRetry: (msg: ChatMessage) => void;
  onMenu: (msg: ChatMessage) => void;
}

const Bubble = React.memo(function Bubble({ msg, ownExtension, client, onRetry, onMenu }: BubbleProps) {
  const { colors } = useTheme();
  const isMine = msg.sender_extension === ownExtension;

  return (
    <View style={[styles.bubbleWrap, isMine ? styles.bubbleWrapRight : styles.bubbleWrapLeft]}>
      <TouchableOpacity
        activeOpacity={0.9}
        onLongPress={() => onMenu(msg)}
        style={[
          styles.bubble,
          isMine
            ? [styles.bubbleMine, { backgroundColor: colors.brand }]
            : [styles.bubbleTheirs, { backgroundColor: colors.surface ?? '#27272a', borderColor: colors.border }],
        ]}
      >
        {msg.type === 'attachment' && msg.attachments?.length ? (
          msg.attachments.map(att => <AttachmentRow key={att.id} att={att} isMine={isMine} client={client} />)
        ) : null}
        {msg.body ? (
          <Text style={[styles.bubbleText, { color: isMine ? '#ffffff' : colors.text }]}>
            {msg.body}
          </Text>
        ) : null}
        <View style={styles.bubbleMeta}>
          <Text style={[styles.bubbleTime, { color: isMine ? 'rgba(255,255,255,0.65)' : colors.textMuted }]}>
            {formatTime(msg.created_at)}
          </Text>
          {msg.pending && <Text style={styles.bubbleSending}> ···</Text>}
          {msg.failed && (
            <TouchableOpacity
              onPress={() => onRetry(msg)}
              accessibilityRole="button"
              accessibilityLabel="Retry failed message"
              style={styles.bubbleStatusIcon}
            >
              <CloseIcon size={11} color="#ef4444" />
            </TouchableOpacity>
          )}
          {isMine && msg.read_at && (
            <View style={styles.bubbleStatusIcon}>
              <DoubleCheckIcon size={13} color="rgba(255,255,255,0.65)" />
            </View>
          )}
        </View>
      </TouchableOpacity>
    </View>
  );
});

function AttachmentRow({ att, isMine, client }: { att: ChatAttachment; isMine: boolean; client: ChatClient }) {
  const { colors } = useTheme();
  const [busy, setBusy] = React.useState(false);
  const req = client.attachmentRequest(att.id);
  const isImage = att.kind === 'image' || att.mime_type.startsWith('image/');
  const isAudio = att.kind === 'audio' || att.mime_type.startsWith('audio/');

  const openAudio = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const file = await ReactNativeBlobUtil.config({ fileCache: true, appendExt: 'bin' }).fetch('GET', req.url, req.headers);
      await Sound.stopPlayer().catch(() => '');
      await Sound.startPlayer(file.path());
    } catch (error) {
      Alert.alert('Voice note', String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const openFile = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const file = await ReactNativeBlobUtil.config({ fileCache: true, appendExt: 'bin' }).fetch('GET', req.url, req.headers);
      const path = file.path();
      if (Platform.OS === 'android') {
        await ReactNativeBlobUtil.android.actionViewIntent(path, att.mime_type || 'application/octet-stream');
      } else {
        await Linking.openURL(`file://${path}`);
      }
    } catch (error) {
      Alert.alert('Attachment', String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  if (isImage) {
    return (
      <TouchableOpacity onPress={openFile} activeOpacity={0.8} style={styles.imageWrap}>
        <Image source={{ uri: req.url, headers: req.headers }} style={styles.image} resizeMode="cover" />
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={isAudio ? openAudio : openFile}
      disabled={busy}
      style={[styles.attachRow, { borderColor: isMine ? 'rgba(255,255,255,0.3)' : colors.border }]}
    >
      <View style={styles.attachLabelRow}>
        {isAudio ? (
          <MicIcon size={14} color={isMine ? '#fff' : colors.textMuted} />
        ) : (
          <FileIcon size={14} color={isMine ? '#fff' : colors.textMuted} />
        )}
        <Text style={[styles.attachName, { color: isMine ? '#fff' : colors.text }]} numberOfLines={1}>
          {isAudio ? 'Voice note' : att.name}
        </Text>
      </View>
      <Text style={[styles.attachSize, { color: isMine ? 'rgba(255,255,255,0.65)' : colors.textMuted }]}>
        {busy ? 'opening…' : att.size > 0 ? `${(att.size / (1024 * 1024)).toFixed(1)} MB` : att.mime_type}
      </Text>
    </TouchableOpacity>
  );
}

function SoundWave({ active }: { active: boolean }) {
  const bars = React.useRef(Array.from({ length: 7 }, () => new Animated.Value(0.3))).current;
  React.useEffect(() => {
    if (!active) {
      bars.forEach(bar => bar.setValue(0.3));
      return;
    }
    const animations = bars.map((bar, index) => Animated.loop(Animated.sequence([
      Animated.timing(bar, { toValue: 1, duration: 260 + index * 35, useNativeDriver: true }),
      Animated.timing(bar, { toValue: 0.25, duration: 240 + index * 30, useNativeDriver: true }),
    ])));
    const timers = animations.map((animation, index) => setTimeout(() => animation.start(), index * 45));
    return () => {
      timers.forEach(clearTimeout);
      animations.forEach(animation => animation.stop());
    };
  }, [active, bars]);
  return (
    <View style={styles.soundWave} accessibilityLabel="Recording voice note">
      {bars.map((bar, index) => (
        <Animated.View
          key={index}
          style={[styles.soundWaveBar, { transform: [{ scaleY: bar }] }]}
        />
      ))}
    </View>
  );
}

function TypingDots() {
  const { colors } = useTheme();
  return (
    <View style={styles.typingWrap}>
      <Text style={[styles.typingText, { color: colors.textMuted }]}>typing…</Text>
    </View>
  );
}

export interface ChatThreadScreenProps {
  conversation: ChatConversation;
  ownExtension: string;
  client: ChatClient;
  cache: ChatCache;
  socket: ChatSocket | null;
  onClose: () => void;
  onCall?: (extension: string) => void;
  /** Called when unread changes so the tab badge updates. */
  onUnreadChange?: () => void;
}

export function ChatThreadScreen({
  conversation,
  ownExtension,
  client,
  cache,
  socket,
  onClose,
  onCall,
  onUnreadChange,
}: ChatThreadScreenProps) {
  const { colors } = useTheme();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [text, setText] = useState('');
  const [toast, setToast] = useState('');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const [forwardTo, setForwardTo] = useState('');
  const [forwardingBusy, setForwardingBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sending, setSending] = useState(false);
  const [typingPeers, setTypingPeers] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [recording, setRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<typeof Sound | null>(null);
  const startingRecordingRef = useRef(false);
  const stoppingRecordingRef = useRef(false);
  const flatRef = useRef<FlatList<ChatMessage>>(null);
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Load cached + fresh messages
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await cache.getMessages(conversation.id);
      if (cached.length && !cancelled) setMessages(cached);

      try {
        const fresh = await client.getMessages(conversation.id);
        if (cancelled) return;
        setMessages(fresh);
        setHasMore(fresh.length >= 50);
        await cache.saveMessages(conversation.id, fresh);
        // Mark latest as read
        const last = fresh[fresh.length - 1];
        if (last) {
          await client.markRead(conversation.id, last.id);
          await cache.markConversationRead(conversation.id);
          onUnreadChange?.();
        }
      } catch {
        // already showing cached
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // Handle incoming socket messages for this conversation
  useEffect(() => {
    if (!socket) return;
    const prevOnMessage = socket['handlers' as keyof typeof socket];
    void prevOnMessage; // just reading the ref does nothing — use a subscription pattern

    // We wire socket events in the parent; here we just listen via a prop callback.
    // The parent already calls onSocketMessage which calls setMessages below.
  }, [socket]);

  /** Called by parent when a new socket message arrives for this conversation. */
  const receiveMessage = useCallback((msg: ChatMessage) => {
    if (msg.conversation_id !== conversation.id) return;
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === msg.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = msg;
        return next;
      }
      return [...prev, msg];
    });
    void cache.upsertMessage(conversation.id, msg);
    void client.markRead(conversation.id, msg.id).then(() => {
      void cache.markConversationRead(conversation.id);
      onUnreadChange?.();
    });
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 50);
  }, [conversation.id, cache, client, onUnreadChange]);

  // Subscribe directly to the live socket while this thread is open.
  useEffect(() => {
    if (!socket) return;
    return socket.onMessage(receiveMessage);
  }, [socket, receiveMessage]);

  const handleTypingEvent = useCallback((data: { conversationId: string; extension: string; isTyping: boolean }) => {
    if (data.conversationId !== conversation.id || data.extension === ownExtension) return;
    setTypingPeers(prev => {
      if (data.isTyping) {
        return prev.includes(data.extension) ? prev : [...prev, data.extension];
      }
      return prev.filter(e => e !== data.extension);
    });
    // Auto-clear after 5s
    clearTimeout(typingTimers.current[data.extension]);
    if (data.isTyping) {
      typingTimers.current[data.extension] = setTimeout(() => {
        setTypingPeers(prev => prev.filter(e => e !== data.extension));
      }, 5_000);
    }
  }, [conversation.id, ownExtension]);

  useEffect(() => {
    if (!socket) return;
    return socket.onTyping(handleTypingEvent);
  }, [socket, handleTypingEvent]);

  const emitTyping = useCallback((active: boolean) => {
    socket?.sendTyping(conversation.id, active);
  }, [socket, conversation.id]);

  const sendText = useCallback(async () => {
    const body = text.trim();
    if (!body || sending) return;
    setText('');
    setSending(true);
    const cid = clientId();
    const optimistic: ChatMessage = {
      id: cid,
      client_id: cid,
      conversation_id: conversation.id,
      sender_extension: ownExtension,
      type: 'text',
      body,
      created_at: new Date().toISOString(),
      pending: true,
    };
    setMessages(prev => [...prev, optimistic]);
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 50);
    try {
      const sent = await client.sendText(conversation.id, body, cid);
      setMessages(prev => prev.map(m => (m.client_id === cid ? sent : m)));
      await cache.upsertMessage(conversation.id, sent);
    } catch {
      setMessages(prev => prev.map(m => m.client_id === cid ? { ...m, pending: false, failed: true } : m));
    } finally {
      setSending(false);
    }
  }, [text, sending, conversation.id, ownExtension, client, cache]);

  const uploadAndSend = useCallback(async (uri: string, name: string, mimeType: string, size: number) => {
    const check = validateAttachment({ uri, name, size, mimeType });
    if (!check.ok) {
      Alert.alert('Attachment', check.error || 'Unsupported attachment.');
      return;
    }
    const cid = clientId();
    setUploadProgress(prev => ({ ...prev, [cid]: 0 }));
    try {
      const attachment = await client.uploadAttachment(uri, name, mimeType, fraction => {
        setUploadProgress(prev => ({ ...prev, [cid]: fraction }));
      });
      const sent = await client.sendAttachment(conversation.id, '', cid, [attachment.id]);
      setMessages(prev => prev.some(m => m.id === sent.id || m.client_id === cid)
        ? prev.map(m => (m.id === sent.id || m.client_id === cid) ? sent : m)
        : [...prev, sent]);
      await cache.upsertMessage(conversation.id, sent);
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 50);
    } catch (error) {
      Alert.alert('Upload failed', String((error as Error)?.message || error));
    } finally {
      setUploadProgress(prev => {
        const next = { ...prev };
        delete next[cid];
        return next;
      });
    }
  }, [client, conversation.id, cache]);

  const pickImage = useCallback(async () => {
    setShowAttachMenu(false);
    try {
      const result = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1 });
      const asset = result.assets?.[0];
      if (!asset?.uri) return;
      await uploadAndSend(
        asset.uri,
        asset.fileName || `image-${Date.now()}.jpg`,
        asset.type || 'image/jpeg',
        asset.fileSize || 0,
      );
    } catch (error) {
      Alert.alert('Image picker', String((error as Error)?.message || error));
    }
  }, [uploadAndSend]);

  const pickFile = useCallback(async () => {
    setShowAttachMenu(false);
    try {
      const [file] = await pick({ type: [types.allFiles], allowMultiSelection: false });
      if (!file?.uri) return;
      await uploadAndSend(
        file.uri,
        file.name || `file-${Date.now()}`,
        file.type || 'application/octet-stream',
        file.size || 0,
      );
    } catch (error) {
      // The picker throws when the user cancels; do not show a false error.
      if (!/cancel/i.test(String((error as Error)?.message || error))) {
        Alert.alert('File picker', String((error as Error)?.message || error));
      }
    }
  }, [uploadAndSend]);

  const handleAttachPress = useCallback(() => {
    setShowAttachMenu(true);
  }, []);

  const startRecording = useCallback(async () => {
    if (recording || startingRecordingRef.current) return;
    startingRecordingRef.current = true;
    try {
      const recorder = recorderRef.current ?? Sound;
      recorderRef.current = recorder;
      const path = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/sokrat-voice-${Date.now()}.m4a`;
      await recorder.startRecorder(path);
      recorder.addRecordBackListener((event: { currentPosition?: number }) => setRecordSeconds(Math.floor((event.currentPosition || 0) / 1000)));
      setRecordSeconds(0);
      setRecordingPaused(false);
      setRecording(true);
    } catch (error) {
      Alert.alert('Voice recorder', String((error as Error)?.message || error));
    } finally {
      startingRecordingRef.current = false;
    }
  }, [recording]);

  const stopRecording = useCallback(async () => {
    if (stoppingRecordingRef.current) return;
    const recorder = recorderRef.current;
    if (!recorder) return;
    stoppingRecordingRef.current = true;
    recorderRef.current = null;
    setRecording(false);
    setRecordingPaused(false);
    recorder.removeRecordBackListener();
    try {
      const path = await recorder.stopRecorder();
      const stat = await ReactNativeBlobUtil.fs.stat(path);
      await uploadAndSend(path, `voice-${Date.now()}.m4a`, 'audio/mp4', Number(stat.size) || 0);
    } catch (error) {
      Alert.alert('Voice note', String((error as Error)?.message || error));
    } finally {
      setRecordSeconds(0);
      stoppingRecordingRef.current = false;
    }
  }, [uploadAndSend]);

  const toggleRecordingPause = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    try {
      if (recordingPaused) {
        await recorder.resumeRecorder();
        setRecordingPaused(false);
      } else {
        await recorder.pauseRecorder();
        setRecordingPaused(true);
      }
    } catch (error) {
      Alert.alert('Voice note', String((error as Error)?.message || error));
    }
  }, [recordingPaused]);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => {
      setToast('');
      toastTimer.current = null;
    }, 2200);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const copyMessage = useCallback((msg: ChatMessage) => {
    if (!msg.body) return;
    Clipboard.setString(msg.body);
    showToast('Message copied');
  }, [showToast]);

  const openMessageActions = useCallback((msg: ChatMessage) => {
    const actions: Array<{ text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }> = [];
    if (msg.body) actions.push({ text: 'Copy', onPress: () => copyMessage(msg) });
    actions.push({ text: 'Forward', onPress: () => { setForwarding(msg); setForwardTo(''); } });
    actions.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Message', undefined, actions);
  }, [copyMessage]);

  const forwardMessage = useCallback(async () => {
    const target = forwardTo.trim();
    if (!forwarding || !target || forwardingBusy) return;
    setForwardingBusy(true);
    try {
      const conv = await client.createConversation(target);
      const cid = clientId();
      if (forwarding.attachments?.length) {
        await client.sendAttachment(conv.id, forwarding.body || '', cid, forwarding.attachments.map(a => a.id));
      } else {
        await client.sendText(conv.id, forwarding.body || '', cid);
      }
      setForwarding(null);
      setForwardTo('');
      showToast(`Forwarded to ${target}`);
    } catch (error) {
      Alert.alert('Forward failed', String((error as Error)?.message || error));
    } finally {
      setForwardingBusy(false);
    }
  }, [client, forwarding, forwardingBusy, forwardTo, showToast]);

  const retryMessage = useCallback(async (msg: ChatMessage) => {
    if (!msg.body || !msg.client_id || sending) return;
    setMessages(prev => prev.map(m => m.client_id === msg.client_id
      ? { ...m, pending: true, failed: false } : m));
    try {
      const sent = await client.sendText(conversation.id, msg.body, msg.client_id);
      setMessages(prev => prev.map(m => m.client_id === msg.client_id ? sent : m));
      await cache.upsertMessage(conversation.id, sent);
    } catch {
      setMessages(prev => prev.map(m => m.client_id === msg.client_id
        ? { ...m, pending: false, failed: true } : m));
    }
  }, [client, cache, conversation.id, sending]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const older = await client.getMessages(conversation.id, 50, messages[0].created_at);
      setMessages(prev => {
        const known = new Set(prev.map(m => m.id));
        return [...older.filter(m => !known.has(m.id)), ...prev];
      });
      setHasMore(older.length >= 50);
    } catch {
      // keep the current thread; the user can retry
    } finally {
      setLoadingOlder(false);
    }
  }, [client, conversation.id, hasMore, loadingOlder, messages]);

  const renderItem = useCallback(({ item }: { item: ChatMessage }) => (
    <Bubble
      msg={item}
      ownExtension={ownExtension}
      client={client}
      onRetry={retryMessage}
      onMenu={openMessageActions}
    />
  ), [client, openMessageActions, ownExtension, retryMessage]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView
        edges={['top', 'bottom']}
        style={[styles.screen, { backgroundColor: colors.bg }]}
      >
        <KeyboardAvoidingView
          style={styles.screen}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
        {/* Header */}
        <View style={[styles.threadHeader, { backgroundColor: 'transparent' }]}>
          <View style={styles.headerSide}>
            <TouchableOpacity
              onPress={onClose}
              style={styles.backBtn}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Back to chats"
            >
              <View style={styles.backRow}>
                <BackIcon size={20} color={colors.brand} />
              </View>
            </TouchableOpacity>
          </View>
          <View style={styles.headerCenter}>
            <Text style={[styles.headerName, { color: colors.text }]} numberOfLines={1}>
              {conversation.name || conversation.extension}
            </Text>
            <Text style={[styles.headerExt, { color: colors.textMuted }]}>ext {conversation.extension}</Text>
          </View>
          <View style={[styles.headerSide, styles.headerSideRight]}>
            {onCall ? (
              <TouchableOpacity
                onPress={() => onCall(conversation.extension)}
                style={[styles.callBtn, { borderColor: colors.brand }]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={`Call ${conversation.name || conversation.extension}`}
              >
                <PhoneIcon size={18} color={colors.brand} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {/* Messages */}
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.brand} />
          </View>
        ) : (
          <FlatList
            ref={flatRef}
            data={messages}
            keyExtractor={m => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.messagesList}
            initialNumToRender={20}
            maxToRenderPerBatch={15}
            windowSize={5}
            ListHeaderComponent={hasMore ? (
              <TouchableOpacity
                onPress={loadOlder}
                disabled={loadingOlder}
                style={styles.loadOlderBtn}
                accessibilityRole="button"
              >
                {loadingOlder
                  ? <ActivityIndicator size="small" color={colors.brand} />
                  : <Text style={[styles.loadOlderText, { color: colors.brand }]}>Load earlier messages</Text>}
              </TouchableOpacity>
            ) : undefined}
            ListFooterComponent={typingPeers.length > 0 ? TypingDots : undefined}
          />
        )}

        {/* Upload and copy popups */}
        {Object.keys(uploadProgress).length > 0 ? (
          <View style={[styles.floatingPopup, styles.uploadPopup, { backgroundColor: colors.surface ?? '#18181b', borderColor: colors.brand }]}>
            <Text style={[styles.popupTitle, { color: colors.text }]}>Uploading attachment…</Text>
            {Object.entries(uploadProgress).map(([cid, frac]) => (
              <View key={cid} style={[styles.uploadBar, { backgroundColor: colors.border }]}>
                <View style={[styles.uploadFill, { width: `${Math.round(frac * 100)}%` as `${number}%`, backgroundColor: colors.brand }]} />
              </View>
            ))}
          </View>
        ) : null}
        {toast ? (
          <View style={[styles.floatingPopup, styles.copyPopup, { backgroundColor: colors.surface ?? '#18181b', borderColor: colors.brand }]}>
            <Text style={[styles.popupTitle, { color: colors.text }]}>{toast}</Text>
          </View>
        ) : null}

        {/* Composer */}
        <View style={[styles.composer, { borderTopColor: colors.border, backgroundColor: colors.surface ?? '#18181b' }]}>
          <TouchableOpacity
            onPress={handleAttachPress}
            style={[styles.composerAction, { borderColor: colors.brand }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Attach file"
          >
            <PaperclipIcon size={22} color={colors.brand} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={recording ? stopRecording : startRecording}
            style={[styles.composerAction, recording && styles.composerActionActive, { borderColor: colors.brand }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={recording ? 'Stop voice recording' : 'Record voice note'}
          >
            {recording ? (
              <StopIcon size={18} color={colors.brand} />
            ) : (
              <MicIcon size={21} color={colors.brand} />
            )}
          </TouchableOpacity>
          {recording ? (
            <View style={[styles.recordingBar, { borderColor: colors.brand, backgroundColor: colors.bg }]}>
              <SoundWave active={!recordingPaused} />
              <Text style={[styles.recordingTimer, { color: colors.brand }]}>
                {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, '0')}
              </Text>
              <TouchableOpacity
                onPress={toggleRecordingPause}
                style={styles.pauseRecordingBtn}
                accessibilityRole="button"
                accessibilityLabel={recordingPaused ? 'Resume voice recording' : 'Pause voice recording'}
              >
                <Text style={[styles.pauseRecordingText, { color: colors.brand }]}>
                  {recordingPaused ? 'Resume' : 'Pause'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TextInput
              style={[styles.composerInput, { color: colors.text, backgroundColor: colors.bg, borderColor: colors.border }]}
              value={text}
              onChangeText={(v) => {
                setText(v);
                emitTyping(v.length > 0);
              }}
              onBlur={() => emitTyping(false)}
              placeholder="Message…"
              placeholderTextColor={colors.textFaint ?? colors.textMuted}
              multiline
              maxLength={4000}
              returnKeyType="default"
            />
          )}
          <TouchableOpacity
            onPress={sendText}
            disabled={!text.trim() || sending || recording}
            style={[styles.composerAction, { borderColor: colors.brand, opacity: (!text.trim() || recording) ? 0.45 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            {sending ? (
              <ActivityIndicator color={colors.brand} size="small" />
            ) : (
              <SendIcon size={19} color={colors.brand} />
            )}
          </TouchableOpacity>
        </View>
        </KeyboardAvoidingView>

        <Modal visible={showAttachMenu} transparent animationType="fade" onRequestClose={() => setShowAttachMenu(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.attachBackdrop} onPress={() => setShowAttachMenu(false)}>
            <View style={[styles.attachMenu, { backgroundColor: colors.surface ?? '#18181b', borderColor: colors.border }]}>
              <Text style={[styles.attachTitle, { color: colors.text }]}>Attach to chat</Text>
              <TouchableOpacity style={[styles.attachOption, { borderColor: colors.border }]} onPress={() => { setShowAttachMenu(false); void pickImage(); }}>
                <Text style={[styles.attachOptionTitle, { color: colors.text }]}>Photo</Text>
                <Text style={[styles.attachOptionSub, { color: colors.textMuted }]}>Choose an image from the gallery</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.attachOption, { borderColor: colors.border }]} onPress={() => { setShowAttachMenu(false); void pickFile(); }}>
                <Text style={[styles.attachOptionTitle, { color: colors.text }]}>File</Text>
                <Text style={[styles.attachOptionSub, { color: colors.textMuted }]}>Share any document up to 50 MB</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.attachCancel} onPress={() => setShowAttachMenu(false)}>
                <Text style={[styles.attachCancelText, { color: colors.textMuted }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        <Modal visible={forwarding !== null} transparent animationType="fade" onRequestClose={() => setForwarding(null)}>
          <View style={styles.forwardBackdrop}>
            <View style={[styles.forwardCard, { backgroundColor: colors.surface ?? '#18181b', borderColor: colors.border }]}>
              <Text style={[styles.forwardTitle, { color: colors.text }]}>Forward message</Text>
              <Text style={[styles.forwardSub, { color: colors.textMuted }]} numberOfLines={2}>
                {forwarding?.body || 'Attachment'}
              </Text>
              <TextInput
                style={[styles.forwardInput, { color: colors.text, backgroundColor: colors.bg, borderColor: colors.border }]}
                value={forwardTo}
                onChangeText={setForwardTo}
                placeholder="Destination extension"
                placeholderTextColor={colors.textFaint ?? colors.textMuted}
                keyboardType="number-pad"
                autoFocus
              />
              <View style={styles.forwardActions}>
                <TouchableOpacity style={styles.forwardCancel} onPress={() => setForwarding(null)}>
                  <Text style={[styles.forwardCancelText, { color: colors.textMuted }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.forwardSend, { backgroundColor: colors.brand }]} onPress={forwardMessage} disabled={!forwardTo.trim() || forwardingBusy}>
                  {forwardingBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.forwardSendText}>Forward</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 0,
    minHeight: 58,
  },
  headerSide: { width: 48, alignItems: 'flex-start', justifyContent: 'center' },
  headerSideRight: { alignItems: 'flex-end' },
  backBtn: { padding: 4 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerName: { fontSize: 16, fontWeight: '700' },
  headerExt: { fontSize: 12, marginTop: 1 },
  callBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  messagesList: { paddingHorizontal: 12, paddingVertical: 12, flexGrow: 1 },
  loadOlderBtn: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16 },
  loadOlderText: { fontSize: 13, fontWeight: '600' },
  bubbleWrap: { marginVertical: 3, maxWidth: '80%' },
  bubbleWrapRight: { alignSelf: 'flex-end' },
  bubbleWrapLeft: { alignSelf: 'flex-start' },
  bubble: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  bubbleMine: { borderBottomRightRadius: 4 },
  bubbleTheirs: { borderWidth: 1, borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  bubbleTime: { fontSize: 10 },
  bubbleSending: { color: '#71717a', fontSize: 10 },
  bubbleStatusIcon: { marginLeft: 3 },
  attachRow: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginBottom: 4,
    gap: 2,
  },
  attachLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  attachName: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
  attachSize: { fontSize: 11 },
  typingWrap: { paddingHorizontal: 16, paddingVertical: 8 },
  typingText: { fontSize: 13, fontStyle: 'italic' },
  uploadBar: { height: 4, marginTop: 8, borderRadius: 2, overflow: 'hidden' },
  uploadFill: { height: '100%' },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    borderTopWidth: 1,
  },
  composerAction: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  composerActionActive: { backgroundColor: 'rgba(235,18,53,0.10)' },
  recordingBar: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  soundWave: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 24 },
  soundWaveBar: { width: 4, height: 22, borderRadius: 2, backgroundColor: '#EB1235' },
  recordingTimer: { fontSize: 12, fontWeight: '700', marginLeft: 10 },
  pauseRecordingBtn: { paddingHorizontal: 8, paddingVertical: 6, marginLeft: 6 },
  pauseRecordingText: { fontSize: 12, fontWeight: '700' },
  imageWrap: { marginBottom: 4, borderRadius: 10, overflow: 'hidden' },
  image: { width: 220, height: 160 },
  floatingPopup: { position: 'absolute', left: 16, right: 16, bottom: 78, zIndex: 10, borderWidth: 1, borderRadius: 14, padding: 12, elevation: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  uploadPopup: {},
  copyPopup: { alignSelf: 'center', alignItems: 'center', left: 40, right: 40 },
  popupTitle: { fontSize: 13, fontWeight: '700' },
  attachBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  attachMenu: { borderWidth: 1, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, paddingBottom: 30 },
  attachTitle: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  attachOption: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 9 },
  attachOptionTitle: { fontSize: 15, fontWeight: '700' },
  attachOptionSub: { fontSize: 12, marginTop: 3 },
  attachCancel: { alignItems: 'center', paddingVertical: 10, marginTop: 2 },
  attachCancelText: { fontSize: 14, fontWeight: '600' },
  forwardBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 },
  forwardCard: { borderWidth: 1, borderRadius: 18, padding: 18 },
  forwardTitle: { fontSize: 18, fontWeight: '700' },
  forwardSub: { fontSize: 13, marginTop: 6, marginBottom: 14 },
  forwardInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  forwardActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 16 },
  forwardCancel: { paddingHorizontal: 14, paddingVertical: 10 },
  forwardCancelText: { fontSize: 14, fontWeight: '600' },
  forwardSend: { borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10, minWidth: 92, alignItems: 'center' },
  forwardSendText: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
    lineHeight: 20,
    textAlignVertical: 'center',
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
