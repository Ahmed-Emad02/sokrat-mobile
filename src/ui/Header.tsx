import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme';
import { SipState } from '../sip/JsSipService';

type Props = {
  extension: string;
  serverHost: string;
  state: SipState;
  isDnd: boolean;
  isAutoAnswer: boolean;
  onToggleDnd: () => void;
  onToggleAutoAnswer: () => void;
};

export function Header({
  extension,
  serverHost,
  state,
  isDnd,
  isAutoAnswer,
  onToggleDnd,
  onToggleAutoAnswer,
}: Props) {
  const getStatusText = () => {
    switch (state) {
      case 'registered':
        return 'Online';
      case 'connecting':
        return 'Connecting';
      case 'retry':
        return 'Reconnecting';
      case 'failed':
        return 'Auth Failed';
      default:
        return 'Offline';
    }
  };

  const getStatusColor = () => {
    switch (state) {
      case 'registered':
        return COLORS.accent;
      case 'connecting':
      case 'retry':
        return COLORS.warn;
      default:
        return COLORS.danger;
    }
  };

  return (
    <View style={styles.header}>
      {/* Top Brand & Identity */}
      <View style={styles.brandRow}>
        <View>
          <View style={styles.titleRow}>
            <Text style={styles.title}>SOKRAT</Text>
            <Text style={styles.badge}>VOICE</Text>
          </View>
          <Text style={styles.subtext}>
            Ext {extension} · {serverHost}
          </Text>
        </View>

        {/* Status Pill */}
        <View style={[styles.statusPill, { borderColor: getStatusColor() }]}>
          <View style={[styles.statusDot, { backgroundColor: getStatusColor() }]} />
          <Text style={[styles.statusText, { color: getStatusColor() }]}>
            {getStatusText()}
          </Text>
        </View>
      </View>

      {/* Quick Action Toggles */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggleBtn, isDnd && styles.toggleBtnDndActive]}
          onPress={onToggleDnd}
        >
          <Text style={styles.toggleIcon}>🚫</Text>
          <Text style={[styles.toggleLabel, isDnd && styles.toggleLabelActive]}>
            DND {isDnd ? 'ON' : 'OFF'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.toggleBtn, isAutoAnswer && styles.toggleBtnAutoActive]}
          onPress={onToggleAutoAnswer}
        >
          <Text style={styles.toggleIcon}>⚡</Text>
          <Text style={[styles.toggleLabel, isAutoAnswer && styles.toggleLabelActive]}>
            Auto-Answer {isAutoAnswer ? 'ON' : 'OFF'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: COLORS.bgElevated,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  brandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 2,
  },
  badge: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    backgroundColor: '#064e3b',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  subtext: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: COLORS.bg,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.bg,
    borderColor: COLORS.border,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  toggleBtnDndActive: {
    borderColor: COLORS.danger,
    backgroundColor: '#450a0a',
  },
  toggleBtnAutoActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#064e3b',
  },
  toggleIcon: {
    fontSize: 12,
  },
  toggleLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  toggleLabelActive: {
    color: COLORS.text,
  },
});
