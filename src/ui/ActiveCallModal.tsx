import React, { useState, useEffect } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { ActiveCall } from '../sip/JsSipService';
import {
  MicIcon,
  MicOffIcon,
  KeypadIcon,
  SpeakerIcon,
  PauseIcon,
  PlayIcon,
  TransferIcon,
  PlusIcon,
  CloseIcon,
} from './Icons';

type Props = {
  call: ActiveCall | null;
  isMuted: boolean;
  isHeld: boolean;
  isSpeaker: boolean;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onToggleSpeaker: () => void;
  onSendDtmf: (digit: string) => void;
  onTransfer: (target: string) => void;
  onHangup: () => void;
};

const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export function ActiveCallModal({
  call,
  isMuted,
  isHeld,
  isSpeaker,
  onToggleMute,
  onToggleHold,
  onToggleSpeaker,
  onSendDtmf,
  onTransfer,
  onHangup,
}: Props) {
  const [seconds, setSeconds] = useState(0);
  const [showDtmf, setShowDtmf] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');

  useEffect(() => {
    if (call?.status !== 'active') {
      setSeconds(0);
      return;
    }
    const updateElapsed = () => {
      const start = call?.startTime || Date.now();
      const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
      setSeconds(elapsed);
    };
    updateElapsed();
    const timer = setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [call?.status, call?.startTime]);

  if (!call) return null;

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const getStatusText = () => {
    if (isHeld) return 'CALL ON HOLD';
    if (call.status === 'calling') return 'CALLING…';
    if (call.status === 'ringing') return 'RINGING…';
    return formatTimer(seconds);
  };

  const handleTransferSubmit = () => {
    if (!transferTarget.trim()) return;
    onTransfer(transferTarget.trim());
    setTransferTarget('');
    setShowTransfer(false);
  };

  return (
    <Modal visible={Boolean(call)} transparent={false} animationType="slide">
      <SafeAreaView style={styles.container}>
        {/* Top Status */}
        <View style={styles.topSection}>
          <Text style={styles.directionText}>
            {call.direction === 'inbound' ? 'INCOMING CALL' : 'OUTGOING CALL'}
          </Text>
          <Text style={[styles.statusText, isHeld && styles.statusHeld]}>
            {getStatusText()}
          </Text>

          <View style={styles.avatarCircle}>
            <Text style={styles.avatarLetter}>
              {call.targetName.charAt(0) || call.target.charAt(0) || '?'}
            </Text>
          </View>

          <Text style={styles.targetName} numberOfLines={1}>
            {call.targetName}
          </Text>
          <Text style={styles.targetNumber}>{call.target}</Text>
        </View>

        {/* DTMF In-Call Overlay */}
        {showDtmf && (
          <View style={styles.dtmfContainer}>
            <View style={styles.dtmfGrid}>
              {DTMF_KEYS.map((digit) => (
                <TouchableOpacity
                  key={digit}
                  style={styles.dtmfKey}
                  onPress={() => onSendDtmf(digit)}
                >
                  <Text style={styles.dtmfDigit}>{digit}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={styles.closeDtmfBtn}
              onPress={() => setShowDtmf(false)}
            >
              <Text style={styles.closeDtmfText}>Hide Keypad</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* In-Call 6-Button Control Grid */}
        {!showDtmf && (
          <View style={styles.controlsGrid}>
            <View style={styles.controlRow}>
              {/* Mute */}
              <TouchableOpacity
                style={[styles.controlBtn, isMuted && styles.controlBtnActive]}
                onPress={onToggleMute}
              >
                <View style={styles.controlIconWrap}>
                  {isMuted ? <MicOffIcon size={24} color="#f87171" /> : <MicIcon size={24} color="#ffffff" />}
                </View>
                <Text style={styles.controlLabel}>{isMuted ? 'Unmute' : 'Mute'}</Text>
              </TouchableOpacity>

              {/* Keypad */}
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={() => setShowDtmf(true)}
              >
                <View style={styles.controlIconWrap}>
                  <KeypadIcon size={24} color="#ffffff" />
                </View>
                <Text style={styles.controlLabel}>Keypad</Text>
              </TouchableOpacity>

              {/* Speaker */}
              <TouchableOpacity
                style={[styles.controlBtn, isSpeaker && styles.controlBtnActive]}
                onPress={onToggleSpeaker}
              >
                <View style={styles.controlIconWrap}>
                  <SpeakerIcon size={24} color={isSpeaker ? '#38bdf8' : '#ffffff'} />
                </View>
                <Text style={styles.controlLabel}>{isSpeaker ? 'Speaker' : 'Earpiece'}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.controlRow}>
              {/* Hold */}
              <TouchableOpacity
                style={[styles.controlBtn, isHeld && styles.controlBtnHoldActive]}
                onPress={onToggleHold}
              >
                <View style={styles.controlIconWrap}>
                  {isHeld ? <PlayIcon size={24} color="#10b981" /> : <PauseIcon size={24} color="#ffffff" />}
                </View>
                <Text style={styles.controlLabel}>{isHeld ? 'Resume' : 'Hold'}</Text>
              </TouchableOpacity>

              {/* Transfer */}
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={() => setShowTransfer(true)}
              >
                <View style={styles.controlIconWrap}>
                  <TransferIcon size={24} color="#ffffff" />
                </View>
                <Text style={styles.controlLabel}>Transfer</Text>
              </TouchableOpacity>

              {/* Add Call (Placeholder for future conf) */}
              <TouchableOpacity
                style={[styles.controlBtn, { opacity: 0.4 }]}
                disabled={true}
              >
                <View style={styles.controlIconWrap}>
                  <PlusIcon size={24} color="#a1a1aa" />
                </View>
                <Text style={styles.controlLabel}>Add Call</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Big Red Hangup Button */}
        <View style={styles.bottomSection}>
          <TouchableOpacity style={styles.hangupBtn} onPress={onHangup}>
            <CloseIcon size={28} color="#ffffff" />
          </TouchableOpacity>
        </View>
        {/* Transfer Modal */}
        <Modal
          visible={showTransfer}
          transparent
          animationType="fade"
          onRequestClose={() => setShowTransfer(false)}
        >
          <View style={styles.transferBackdrop}>
            <View style={styles.transferCard}>
              <Text style={styles.transferTitle}>Transfer Call</Text>
              <Text style={styles.transferSub}>
                Transfer {call.targetName || call.target} to another extension:
              </Text>

              <TextInput
                style={styles.transferInput}
                value={transferTarget}
                onChangeText={setTransferTarget}
                placeholder="Extension (e.g. 102)"
                placeholderTextColor={COLORS.textMuted}
                keyboardType="number-pad"
                autoFocus
              />

              <View style={styles.transferActions}>
                <TouchableOpacity
                  style={styles.transferCancelBtn}
                  onPress={() => setShowTransfer(false)}
                >
                  <Text style={styles.transferCancelText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.transferSubmitBtn}
                  onPress={handleTransferSubmit}
                >
                  <Text style={styles.transferSubmitText}>Transfer</Text>
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
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  topSection: {
    alignItems: 'center',
    marginTop: 20,
  },
  directionText: {
    color: COLORS.textMuted,
    fontSize: 12,
    letterSpacing: 3,
    fontWeight: '700',
  },
  statusText: {
    color: COLORS.accent,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  statusHeld: {
    color: COLORS.warn,
  },
  avatarCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.accent,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  avatarLetter: {
    color: COLORS.accent,
    fontSize: 40,
    fontWeight: '700',
  },
  targetName: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: '700',
    marginTop: 16,
    textAlign: 'center',
  },
  targetNumber: {
    color: COLORS.textMuted,
    fontSize: 16,
    marginTop: 4,
  },
  controlsGrid: {
    gap: 20,
    paddingHorizontal: 12,
  },
  controlRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  controlBtn: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#064e3b',
  },
  controlBtnHoldActive: {
    borderColor: COLORS.warn,
    backgroundColor: '#78350f',
  },
  controlIconWrap: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlLabel: {
    color: COLORS.textDim,
    fontSize: 11,
    marginTop: 4,
    fontWeight: '600',
  },
  dtmfContainer: {
    backgroundColor: COLORS.bgElevated,
    borderRadius: 16,
    padding: 16,
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  dtmfGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  dtmfKey: {
    width: '30%',
    aspectRatio: 1.4,
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  dtmfDigit: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '700',
  },
  closeDtmfBtn: {
    alignItems: 'center',
    marginTop: 12,
    paddingVertical: 8,
  },
  closeDtmfText: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  bottomSection: {
    alignItems: 'center',
    marginBottom: 20,
  },
  hangupBtn: {
    width: 72,
    height: 72,
    backgroundColor: COLORS.danger,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.danger,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  hangupIcon: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '700',
  },
  // Transfer Modal
  transferBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  transferCard: {
    backgroundColor: COLORS.bgElevated,
    borderRadius: 12,
    padding: 20,
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  transferTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
  },
  transferSub: {
    color: COLORS.textMuted,
    fontSize: 13,
    marginTop: 4,
    marginBottom: 16,
  },
  transferInput: {
    backgroundColor: COLORS.bg,
    color: COLORS.text,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  transferActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 20,
  },
  transferCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  transferCancelText: {
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  transferSubmitBtn: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  transferSubmitText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
});
