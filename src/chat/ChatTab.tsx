/**
 * Chat tab — conversation list with unread badges, search, and new-chat picker.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { useTheme } from '../theme';
import type { ChatConversation, PbxExtension, UnreadSummary } from './types';
import type { ChatClient } from './client';
import { ChatCache } from './cache';
import type { SavedAccount } from '../storage/store';

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return d.toLocaleDateString();
}

interface ConvRowProps {
  item: ChatConversation;
  unread: number;
  pinned: boolean;
  muted: boolean;
  onPress: (conv: ChatConversation) => void;
  onLongPress: (conv: ChatConversation) => void;
}

const ConvRow = React.memo(function ConvRow({ item, unread, pinned, muted, onPress, onLongPress }: ConvRowProps) {
  const { colors } = useTheme();
  const displayName = item.name || item.extension;
  const showExt = displayName !== item.extension;
  const preview = item.last_message?.body ?? '';
  const ts = item.last_message?.created_at ?? item.updated_at;

  return (
    <TouchableOpacity style={styles.row} onPress={() => onPress(item)} onLongPress={() => onLongPress(item)} activeOpacity={0.75}>
      <View style={[styles.avatar, { backgroundColor: colors.brandSoft ?? '#0c2738' }]}>
        <Text style={[styles.avatarText, { color: colors.brand }]}>
          {displayName.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <View style={styles.rowNameWrap}>
            <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
              {displayName}
            </Text>
            {showExt ? (
              <Text style={[styles.rowExt, { color: colors.textMuted }]} numberOfLines={1}>
                · {item.extension}
              </Text>
            ) : null}
            {pinned ? <Text style={[styles.rowFlag, { color: colors.brand }]}>PINNED</Text> : null}
            {muted ? <Text style={[styles.rowFlag, { color: colors.textMuted }]}>MUTED</Text> : null}
          </View>
          <Text style={[styles.rowTime, { color: colors.textMuted }]}>{formatTimestamp(ts)}</Text>
        </View>
        <View style={styles.rowBottom}>
          <Text style={[styles.rowPreview, { color: colors.textMuted }]} numberOfLines={1}>
            {preview}
          </Text>
          {unread > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.brand }]}>
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : String(unread)}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
});

interface ExtPickerProps {
  visible: boolean;
  extensions: PbxExtension[];
  loading: boolean;
  onSelect: (ext: PbxExtension) => void;
  onClose: () => void;
}

function ExtPicker({ visible, extensions, loading, onSelect, onClose }: ExtPickerProps) {
  const { colors } = useTheme();
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const lq = q.toLowerCase();
    return lq ? extensions.filter(e => e.extension.includes(lq) || e.name.toLowerCase().includes(lq)) : extensions;
  }, [extensions, q]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.pickerBackdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
        <View style={[styles.pickerCard, { backgroundColor: colors.surface ?? '#18181b', borderColor: colors.border }]}>
          <Text style={[styles.pickerTitle, { color: colors.text }]}>New Conversation</Text>
          <TextInput
            style={[styles.pickerSearch, { color: colors.text, backgroundColor: colors.bg, borderColor: colors.border }]}
            value={q}
            onChangeText={setQ}
            placeholder="Search extension or name…"
            placeholderTextColor={colors.textFaint ?? colors.textMuted}
            autoFocus
          />
          {loading ? (
            <ActivityIndicator color={colors.brand} style={{ marginTop: 20 }} />
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={e => e.extension}
              style={{ maxHeight: 320 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.extRow} onPress={() => onSelect(item)}>
                  <Text style={[styles.extExt, { color: colors.brand }]}>{item.extension}</Text>
                  <Text style={[styles.extName, { color: colors.text }]}>{item.name}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: colors.textMuted }]}>No extensions found.</Text>
              }
            />
          )}
          <TouchableOpacity onPress={onClose} style={[styles.pickerCancelBtn, { borderColor: colors.border }]}>
            <Text style={[styles.pickerCancelText, { color: colors.textMuted }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export interface ChatTabProps {
  account: SavedAccount | null;
  client: ChatClient | null;
  cache: ChatCache | null;
  unread: UnreadSummary;
  /** Called when user taps a conversation to open the thread. */
  onOpenThread: (conv: ChatConversation) => void;
  /** Live conversations list — updated by the parent service layer. */
  conversations: ChatConversation[];
  onRefresh: () => Promise<void>;
}

export function ChatTab({
  account,
  client,
  cache,
  unread,
  onOpenThread,
  conversations,
  onRefresh,
}: ChatTabProps) {
  const { colors } = useTheme();
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [extensions, setExtensions] = useState<PbxExtension[]>([]);
  const [extLoading, setExtLoading] = useState(false);
  const [creatingExt, setCreatingExt] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [muted, setMuted] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!cache) return;
    let cancelled = false;
    void cache.getConversationPrefs().then(prefs => {
      if (cancelled) return;
      setPinned(new Set(prefs.pinned));
      setMuted(new Set(prefs.muted));
    });
    return () => { cancelled = true; };
  }, [cache]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const rows = !q ? conversations : conversations.filter(c =>
      c.extension.includes(q) || (c.name ?? '').toLowerCase().includes(q));
    return [...rows].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
  }, [conversations, pinned, search]);

  const updatePrefs = useCallback(async (nextPinned: Set<string>, nextMuted: Set<string>) => {
    setPinned(nextPinned);
    setMuted(nextMuted);
    await cache?.saveConversationPrefs({
      pinned: [...nextPinned],
      muted: [...nextMuted],
    });
  }, [cache]);

  const togglePin = useCallback((conv: ChatConversation) => {
    const next = new Set(pinned);
    if (next.has(conv.id)) next.delete(conv.id); else next.add(conv.id);
    void updatePrefs(next, muted);
  }, [muted, pinned, updatePrefs]);

  const toggleMute = useCallback((conv: ChatConversation) => {
    const next = new Set(muted);
    if (next.has(conv.id)) next.delete(conv.id); else next.add(conv.id);
    void updatePrefs(pinned, next);
  }, [muted, pinned, updatePrefs]);

  const openConversationActions = useCallback((conv: ChatConversation) => {
    Alert.alert(conv.name || conv.extension, undefined, [
      { text: pinned.has(conv.id) ? 'Unpin' : 'Pin', onPress: () => togglePin(conv) },
      { text: muted.has(conv.id) ? 'Unmute' : 'Mute', onPress: () => toggleMute(conv) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [muted, pinned, toggleMute, togglePin]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  }, [onRefresh]);

  const openPicker = useCallback(async () => {
    setShowPicker(true);
    if (!client || extensions.length > 0) return;
    setExtLoading(true);
    try {
      setExtensions(await client.getExtensions());
    } catch {
      // non-fatal; picker shows empty
    } finally {
      setExtLoading(false);
    }
  }, [client, extensions.length]);

  const handleSelectExt = useCallback(async (ext: PbxExtension) => {
    if (!client) return;
    setShowPicker(false);
    setCreatingExt(ext.extension);
    try {
      const conv = await client.createConversation(ext.extension);
      onOpenThread({ ...conv, name: ext.name || conv.name });
    } catch {
      // show nothing — user can try again
    } finally {
      setCreatingExt(null);
    }
  }, [client, onOpenThread]);

  const renderItem = useCallback(({ item }: { item: ChatConversation }) => (
    <ConvRow
      item={item}
      unread={unread.per_conversation[item.id] ?? 0}
      pinned={pinned.has(item.id)}
      muted={muted.has(item.id)}
      onPress={onOpenThread}
      onLongPress={openConversationActions}
    />
  ), [muted, openConversationActions, pinned, unread, onOpenThread]);

  if (!account) {
    return (
      <View style={styles.centered}>
        <Text style={{ color: colors.textMuted }}>Sign in to use chat.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TextInput
          style={[styles.search, { color: colors.text, backgroundColor: colors.surface ?? '#18181b', borderColor: colors.border }]}
          value={search}
          onChangeText={setSearch}
          placeholder="Search conversations…"
          placeholderTextColor={colors.textFaint ?? colors.textMuted}
        />
        <TouchableOpacity
          style={[styles.newBtn, { backgroundColor: colors.brand }]}
          onPress={openPicker}
          disabled={creatingExt !== null}
        >
          {creatingExt ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.newBtnText}>+</Text>
          )}
        </TouchableOpacity>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={c => c.id}
        renderItem={renderItem}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>
            {search ? 'No matching conversations.' : 'No conversations yet. Tap + to start one.'}
          </Text>
        }
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={Platform.OS === 'android'}
      />

      <ExtPicker
        visible={showPicker}
        extensions={extensions}
        loading={extLoading}
        onSelect={handleSelectExt}
        onClose={() => setShowPicker(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  search: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    fontSize: 14,
    borderWidth: 1,
  },
  newBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newBtnText: { color: '#ffffff', fontSize: 22, fontWeight: '700', lineHeight: 26 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 18, fontWeight: '700' },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowNameWrap: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 },
  rowName: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  rowExt: { fontSize: 12, fontWeight: '500', flexShrink: 0 },
  rowFlag: { fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },
  rowTime: { fontSize: 12, marginLeft: 8 },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  rowPreview: { fontSize: 13, flex: 1 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    marginLeft: 8,
  },
  badgeText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  emptyText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  // Picker
  pickerBackdrop: { flex: 1, justifyContent: 'flex-end' },
  pickerCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    padding: 20,
    paddingBottom: 32,
  },
  pickerTitle: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  pickerSearch: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    fontSize: 14,
    borderWidth: 1,
    marginBottom: 10,
  },
  extRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  extExt: { fontSize: 14, fontWeight: '700', width: 48 },
  extName: { fontSize: 14, flex: 1 },
  pickerCancelBtn: {
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  pickerCancelText: { fontSize: 15, fontWeight: '600' },
});
