/**
 * Sokrat VOICE — Login / account screen.
 * Collects the SIP extension + password, registers to Asterisk, and
 * binds the device token to the extension on the push gateway.
 */
import React, { useState } from 'react';
import {
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';

type Props = {
  onLogin: (ext: string, password: string) => void;
  state: string; // 'connecting' | 'registered' | 'failed' | ...
  registeredAs?: string;
};

export function LoginScreen({ onLogin, state, registeredAs }: Props) {
  const [extension, setExtension] = useState('');
  const [password, setPassword] = useState('');

  const submit = () => {
    if (!extension || !password) return;
    onLogin(extension.trim(), password);
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.logo}>SOKRAT</Text>
      <Text style={styles.subtitle}>VOICE · Mobile</Text>
      {registeredAs ? (
        <>
          <Text style={styles.registeredLine}>Signed in as ext {registeredAs}</Text>
          <Text style={[styles.ok, { marginTop: 8 }]}>
            {state === 'registered' ? 'Registered ✓' : 'Registered ✓'}
          </Text>
        </>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>EXTENSION</Text>
          <TextInput
            style={styles.input}
            value={extension}
            onChangeText={setExtension}
            placeholder="e.g. 150"
            placeholderTextColor={COLORS.textMuted}
            keyboardType="number-pad"
          />
          <Text style={styles.label}>PASSWORD</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="SIP password"
            placeholderTextColor={COLORS.textMuted}
            secureTextEntry
          />
          <TouchableOpacity style={styles.button} onPress={submit}>
            <Text style={styles.buttonText}>
              {state === 'connecting' ? 'REGISTERING…' : 'SIGN IN'}
            </Text>
          </TouchableOpacity>
          {state === 'failed' && <Text style={styles.error}>Registration failed</Text>}
          {state === 'registered' && <Text style={styles.ok}>Registered ✓</Text>}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center', padding: 24 },
  logo: { color: COLORS.text, fontSize: 40, fontWeight: '700', letterSpacing: 4 },
  subtitle: { color: COLORS.accent, fontSize: 14, letterSpacing: 6, marginBottom: 40 },
  registeredLine: { color: COLORS.textDim, fontSize: 18, textAlign: 'center', marginBottom: 12 },
  card: { gap: 8 },
  label: { color: COLORS.textMuted, fontSize: 11, letterSpacing: 2, marginTop: 12 },
  input: {
    backgroundColor: COLORS.bgElevated, color: COLORS.text, borderRadius: 8,
    padding: 14, fontSize: 16, borderColor: COLORS.border, borderWidth: 1,
  },
  button: {
    backgroundColor: COLORS.accent, borderRadius: 8, padding: 16,
    marginTop: 24, alignItems: 'center',
  },
  buttonText: { color: '#0f172a', fontWeight: '700', letterSpacing: 1 },
  error: { color: COLORS.danger, marginTop: 12, textAlign: 'center' },
  ok: { color: COLORS.accent, marginTop: 12, textAlign: 'center' },
});
