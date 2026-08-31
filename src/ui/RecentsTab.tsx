import React from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../theme';
import { CallRecord } from '../storage/store';

type Props = {
  calls: CallRecord[];
  onCallNumber: (num: string) => void;
  onClearHistory: () => void;
};

export function RecentsTab({ calls, onCallNumber, onClearHistory }: Props) {
  const formatTimeAgo = (ts: number) => {
    const elapsed = Math.floor((Date.now() - ts) / 1000);
    if (elapsed < 60) return 'Just now';
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const formatDuration = (sec?: number) => {
    if (!sec) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const getDirectionIcon = (dir: CallRecord['direction']) => {
    switch (dir) {
      case 'inbound':
        return { icon: '↙', color: COLORS.accent };
      case 'outbound':
        return { icon: '↗', color: COLORS.info };
      case 'missed':
        return { icon: '✕', color: COLORS.danger };
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Text style={styles.headerTitle}>Call History ({calls.length})</Text>
        {calls.length > 0 && (
          <TouchableOpacity onPress={onClearHistory} style={styles.clearBtn}>
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {calls.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>📞</Text>
          <Text style={styles.emptyTitle}>No call logs yet</Text>
          <Text style={styles.emptySub}>Your recent calls will show up here</Text>
        </View>
      ) : (
        <FlatList
          data={calls}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const { icon, color } = getDirectionIcon(item.direction);
            return (
              <TouchableOpacity
                style={styles.callItem}
                onPress={() => onCallNumber(item.number)}
              >
                <View style={[styles.iconCircle, { borderColor: color }]}>
                  <Text style={[styles.dirIcon, { color }]}>{icon}</Text>
                </View>

                <View style={styles.infoCol}>
                  <Text style={styles.callerName} numberOfLines={1}>
                    {item.name || item.number}
                  </Text>
                  <Text style={styles.callerNum}>{item.number}</Text>
                </View>

                <View style={styles.metaCol}>
                  <Text style={styles.timeText}>{formatTimeAgo(item.timestamp)}</Text>
                  {item.duration ? (
                    <Text style={styles.durText}>{formatDuration(item.duration)}</Text>
                  ) : null}
                </View>

                <TouchableOpacity
                  style={styles.callActionBtn}
                  onPress={() => onCallNumber(item.number)}
                >
                  <Text style={styles.callActionIcon}>📞</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  clearBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  clearText: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    paddingVertical: 8,
  },
  callItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    backgroundColor: COLORS.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dirIcon: {
    fontSize: 16,
    fontWeight: '700',
  },
  infoCol: {
    flex: 1,
    marginLeft: 14,
  },
  callerName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  },
  callerNum: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  metaCol: {
    alignItems: 'flex-end',
    marginRight: 14,
  },
  timeText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  durText: {
    color: COLORS.accent,
    fontSize: 11,
    marginTop: 2,
    fontWeight: '600',
  },
  callActionBtn: {
    padding: 8,
    backgroundColor: '#064e3b',
    borderRadius: 20,
  },
  callActionIcon: {
    fontSize: 16,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    opacity: 0.4,
    marginBottom: 16,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
  },
  emptySub: {
    color: COLORS.textMuted,
    fontSize: 13,
    marginTop: 4,
    textAlign: 'center',
  },
});
