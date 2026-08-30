/**
 * Sokrat VOICE — incoming call ringing overlay.
 * Mirrors the native CallKit screen so the app's in-app view stays in sync.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../theme';

type Props = {
  callerId: string;
  callerName: string;
  onAnswer: () => void;
  onDecline: () => void;
};

export function RingingScreen({ callerId, callerName, onAnswer, onDecline }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.incoming}>INCOMING CALL</Text>
      <View style={styles.idAvatar}>
        <Text style={styles.idInitial}>{callerName.charAt(0) || callerId.charAt(0) || '?'}</Text>
      </View>
      <Text style={styles.name}>{callerName || callerId}</Text>
      <Text style={styles.id}>{callerId}</Text>

      <View style={styles.actions}>
        <View style={styles.actionWrap}>
          <Text style={styles.actionLabel}>DECLINE</Text>
          <View style={[styles.round, styles.decline]} onTouchEnd={onDecline}>
            <Text style={styles.roundIcon}>✕</Text>
          </View>
        </View>
        <Text style={styles.pulse}>●</Text>
        <View style={styles.actionWrap}>
          <Text style={styles.actionLabel}>ANSWER</Text>
          <View style={[styles.round, styles.answer]} onTouchEnd={onAnswer}>
            <Text style={styles.roundIcon}>◄</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: COLORS.bg, alignItems: 'center', paddingTop: 120,
  },
  incoming: { color: COLORS.textMuted, fontSize: 12, letterSpacing: 6, marginBottom: 60 },
  idAvatar: {
    width: 120, height: 120, borderRadius: 60, backgroundColor: COLORS.bgElevated,
    alignItems: 'center', justifyContent: 'center', borderColor: COLORS.accent, borderWidth: 2,
  },
  idInitial: { color: COLORS.accent, fontSize: 52, fontWeight: '700' },
  name: { color: COLORS.text, fontSize: 28, fontWeight: '700', marginTop: 28 },
  id: { color: COLORS.textMuted, fontSize: 18, marginTop: 6 },
  actions: {
    flexDirection: 'row', marginTop: 'auto', marginBottom: 90,
    justifyContent: 'space-between', width: '80%', alignItems: 'flex-end',
  },
  actionWrap: { alignItems: 'center', gap: 12 },
  actionLabel: { color: COLORS.textMuted, fontSize: 11, letterSpacing: 2 },
  round: {
    width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center',
  },
  answer: { backgroundColor: COLORS.accent },
  decline: { backgroundColor: COLORS.danger },
  roundIcon: { color: '#0f172a', fontSize: 28, fontWeight: '700' },
  pulse: { color: COLORS.accent, fontSize: 18, marginBottom: 24 },
});
