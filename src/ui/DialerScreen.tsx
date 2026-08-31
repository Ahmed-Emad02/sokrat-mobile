import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { SipState } from '../sip/sipService';

type Props = {
  extension: string;
  state: SipState;
  onCall: (target: string) => void;
  onHangup: () => void;
  onLogout: () => void;
  activeCall: {
    target: string;
    status: 'calling' | 'active';
  } | null;
  isMuted?: boolean;
  isSpeaker?: boolean;
  onToggleMute?: () => void;
  onToggleSpeaker?: () => void;
};

const KEYS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

export function DialerScreen({
  extension,
  state,
  onCall,
  onHangup,
  onLogout,
  activeCall,
  isMuted = false,
  isSpeaker = false,
  onToggleMute,
  onToggleSpeaker,
}: Props) {
  const [digits, setDigits] = useState('');
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let timer: number | undefined;
    if (activeCall?.status === 'active') {
      timer = setInterval(() => setSeconds((s) => s + 1), 1000) as unknown as number;
    } else {
      setSeconds(0);
    }
    return () => {
      clearInterval(timer);
    };
  }, [activeCall?.status]);

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const handleKeyPress = (digit: string) => {
    setDigits((prev) => prev + digit);
  };

  const handleBackspace = () => {
    setDigits((prev) => prev.slice(0, -1));
  };

  const handleCall = () => {
    if (!digits.trim()) return;
    onCall(digits.trim());
  };

  if (activeCall) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.activeCallContainer}>
          <Text style={styles.activeCallLabel}>
            {activeCall.status === 'calling' ? 'CALLING…' : 'CONNECTED'}
          </Text>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{activeCall.target.charAt(0) || '?'}</Text>
          </View>
          <Text style={styles.activeTarget}>{activeCall.target}</Text>
          {activeCall.status === 'active' && (
            <Text style={styles.timerText}>{formatTimer(seconds)}</Text>
          )}

          <View style={styles.inCallControls}>
            <TouchableOpacity
              style={[styles.controlBtn, isMuted && styles.controlBtnActive]}
              onPress={onToggleMute}
            >
              <Text style={styles.controlBtnIcon}>{isMuted ? '🔇' : '🎙️'}</Text>
              <Text style={styles.controlBtnText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.controlBtn, isSpeaker && styles.controlBtnActive]}
              onPress={onToggleSpeaker}
            >
              <Text style={styles.controlBtnIcon}>{isSpeaker ? '🔊' : '🔈'}</Text>
              <Text style={styles.controlBtnText}>{isSpeaker ? 'Speaker' : 'Earpiece'}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.hangupBtn} onPress={onHangup}>
            <Text style={styles.hangupIcon}>✕</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Top Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.extBadge}>EXT: {extension}</Text>
          <Text style={state === 'registered' ? styles.statusOk : styles.statusWait}>
            {state === 'registered' ? '● Online (Registered)' : '○ Connecting…'}
          </Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={onLogout}>
          <Text style={styles.logoutText}>SIGN OUT</Text>
        </TouchableOpacity>
      </View>

      {/* Number Display */}
      <View style={styles.displayRow}>
        <Text style={styles.displayText} numberOfLines={1}>
          {digits || ' '}
        </Text>
        {digits.length > 0 && (
          <TouchableOpacity style={styles.backspaceBtn} onPress={handleBackspace}>
            <Text style={styles.backspaceIcon}>⌫</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 3x4 Keypad */}
      <View style={styles.keypad}>
        {KEYS.map((k) => (
          <TouchableOpacity
            key={k.digit}
            style={styles.key}
            onPress={() => handleKeyPress(k.digit)}
          >
            <Text style={styles.keyDigit}>{k.digit}</Text>
            {k.sub ? <Text style={styles.keySub}>{k.sub}</Text> : null}
          </TouchableOpacity>
        ))}
      </View>

      {/* Call Button */}
      <View style={styles.callRow}>
        <TouchableOpacity
          style={[styles.callBtn, !digits && styles.callBtnDisabled]}
          onPress={handleCall}
          disabled={!digits}
        >
          <Text style={styles.callBtnIcon}>📞</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 24,
    paddingVertical: 12,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  extBadge: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },
  statusOk: {
    color: COLORS.accent,
    fontSize: 12,
    marginTop: 2,
    fontWeight: '600',
  },
  statusWait: {
    color: COLORS.warn,
    fontSize: 12,
    marginTop: 2,
    fontWeight: '600',
  },
  logoutBtn: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  logoutText: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  displayRow: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  displayText: {
    color: COLORS.text,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 2,
    textAlign: 'center',
  },
  backspaceBtn: {
    position: 'absolute',
    right: 12,
    padding: 8,
  },
  backspaceIcon: {
    color: COLORS.textMuted,
    fontSize: 24,
  },
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    rowGap: 14,
  },
  key: {
    width: '28%',
    aspectRatio: 1,
    backgroundColor: COLORS.bgElevated,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  keyDigit: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '600',
  },
  keySub: {
    color: COLORS.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 2,
  },
  callRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  callBtn: {
    width: 68,
    height: 68,
    backgroundColor: COLORS.accent,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtnDisabled: {
    opacity: 0.4,
  },
  callBtnIcon: {
    fontSize: 28,
  },
  // In-call UI
  activeCallContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 32,
  },
  activeCallLabel: {
    color: COLORS.textMuted,
    fontSize: 14,
    letterSpacing: 4,
    fontWeight: '700',
  },
  avatarCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.accent,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: COLORS.accent,
    fontSize: 44,
    fontWeight: '700',
  },
  activeTarget: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: '700',
  },
  timerText: {
    color: COLORS.accent,
    fontSize: 20,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  inCallControls: {
    flexDirection: 'row',
    gap: 32,
  },
  controlBtn: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#064e3b',
  },
  controlBtnIcon: {
    fontSize: 24,
  },
  controlBtnText: {
    color: COLORS.textDim,
    fontSize: 11,
    marginTop: 4,
    fontWeight: '600',
  },
  hangupBtn: {
    width: 72,
    height: 72,
    backgroundColor: COLORS.danger,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hangupIcon: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '700',
  },
});
