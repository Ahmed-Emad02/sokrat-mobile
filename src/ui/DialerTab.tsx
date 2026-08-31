import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../theme';

type Props = {
  onCall: (target: string) => void;
  isRegistered: boolean;
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

const QUICK_CODES = [
  { label: 'Echo (*88)', code: '*88' },
  { label: 'Intercom (*800)', code: '*800' },
  { label: 'Pickup (*)', code: '*' },
];

export function DialerTab({ onCall, isRegistered }: Props) {
  const [digits, setDigits] = useState('');

  const handleKeyPress = (digit: string) => {
    setDigits((prev) => prev + digit);
  };

  const handleBackspace = () => {
    setDigits((prev) => prev.slice(0, -1));
  };

  const handleCall = () => {
    if (!digits.trim() || !isRegistered) return;
    onCall(digits.trim());
  };

  const handleQuickCode = (code: string) => {
    setDigits(code);
  };

  return (
    <View style={styles.container}>
      {/* Number Display Row */}
      <View style={styles.displayContainer}>
        <TextInput
          style={styles.displayText}
          value={digits}
          onChangeText={setDigits}
          placeholder="Enter number or ext…"
          placeholderTextColor={COLORS.textMuted}
          keyboardType="default"
          autoFocus={false}
          showSoftInputOnFocus={false}
        />
        {digits.length > 0 && (
          <TouchableOpacity style={styles.backspaceBtn} onPress={handleBackspace}>
            <Text style={styles.backspaceIcon}>⌫</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Feature Code Chips */}
      <View style={styles.quickChipsRow}>
        {QUICK_CODES.map((q) => (
          <TouchableOpacity
            key={q.code}
            style={styles.chipBtn}
            onPress={() => handleQuickCode(q.code)}
          >
            <Text style={styles.chipText}>{q.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 3x4 Grid Keypad */}
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
          style={[styles.callBtn, (!digits || !isRegistered) && styles.callBtnDisabled]}
          onPress={handleCall}
          disabled={!digits || !isRegistered}
        >
          <Text style={styles.callBtnIcon}>📞</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  displayContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.bgElevated,
    borderRadius: 12,
    borderColor: COLORS.border,
    borderWidth: 1,
    minHeight: 56,
    paddingHorizontal: 16,
  },
  displayText: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 2,
    textAlign: 'center',
    flex: 1,
  },
  backspaceBtn: {
    padding: 6,
  },
  backspaceIcon: {
    color: COLORS.textMuted,
    fontSize: 22,
  },
  quickChipsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginVertical: 6,
  },
  chipBtn: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  chipText: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: '600',
  },
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
    marginHorizontal: 12,
  },
  key: {
    width: '29%',
    aspectRatio: 1.1,
    backgroundColor: COLORS.bgElevated,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  keyDigit: {
    color: COLORS.text,
    fontSize: 26,
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
    marginTop: 6,
    marginBottom: 4,
  },
  callBtn: {
    width: 64,
    height: 64,
    backgroundColor: COLORS.accent,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  callBtnDisabled: {
    opacity: 0.35,
  },
  callBtnIcon: {
    fontSize: 26,
  },
});
