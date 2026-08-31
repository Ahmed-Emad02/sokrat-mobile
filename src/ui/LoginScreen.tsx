/**
 * Sokrat VOICE — Login / Authentication Screen.
 * Full-screen standalone sign-in view.
 */
import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { CONFIG } from '../config';
import { SettingsIcon, PhoneIcon } from './Icons';

type Props = {
  onLogin: (ext: string, password: string, serverHost: string) => void;
  state: string;
};

export function LoginScreen({ onLogin, state }: Props) {
  const [extension, setExtension] = useState('150');
  const [password, setPassword] = useState('sss333');
  const [serverHost, setServerHost] = useState(CONFIG.sipDomain || '192.168.100.128');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const submit = () => {
    if (!extension.trim() || !password.trim()) return;
    onLogin(extension.trim(), password.trim(), (serverHost || '192.168.100.128').trim());
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {/* Brand Header */}
        <View style={styles.brandContainer}>
          <View style={styles.logoBadge}>
            <PhoneIcon size={28} color="#10b981" />
          </View>
          <Text style={styles.logoTitle}>SOKRAT</Text>
          <Text style={styles.logoSubtitle}>VOICE · PJSIP Mobile</Text>
        </View>

        {/* Form Card */}
        <View style={styles.card}>
          <Text style={styles.label}>SIP EXTENSION</Text>
          <TextInput
            style={styles.input}
            value={extension}
            onChangeText={setExtension}
            placeholder="e.g. 150"
            placeholderTextColor="#71717a"
            keyboardType="number-pad"
          />

          <Text style={styles.label}>SIP PASSWORD</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="SIP Secret"
            placeholderTextColor="#71717a"
            secureTextEntry
          />

          {/* Expandable PBX Server Host Config */}
          <TouchableOpacity
            style={styles.advancedToggle}
            onPress={() => setShowAdvanced(!showAdvanced)}
          >
            <SettingsIcon size={14} color="#38bdf8" />
            <Text style={styles.advancedToggleText}>
              {showAdvanced ? 'Hide Server Settings' : `Server: ${serverHost}`}
            </Text>
          </TouchableOpacity>

          {showAdvanced && (
            <View style={styles.advancedBox}>
              <Text style={styles.label}>PBX HOST / IP ADDRESS</Text>
              <TextInput
                style={styles.input}
                value={serverHost}
                onChangeText={setServerHost}
                placeholder="192.168.100.128"
                placeholderTextColor="#71717a"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          )}

          {/* Submit Button */}
          <TouchableOpacity
            style={[styles.button, state === 'connecting' && styles.buttonDisabled]}
            onPress={submit}
            disabled={state === 'connecting'}
          >
            <Text style={styles.buttonText}>
              {state === 'connecting' ? 'CONNECTING…' : 'SIGN IN'}
            </Text>
          </TouchableOpacity>

          {state === 'failed' && (
            <Text style={styles.errorText}>
              Connection failed. Please check host and extension secret.
            </Text>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  content: {
    width: '100%',
  },
  brandContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logoBadge: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#18181b',
    borderColor: '#10b981',
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  logoTitle: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 4,
  },
  logoSubtitle: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2,
    marginTop: 4,
  },
  card: {
    backgroundColor: '#18181b',
    borderRadius: 16,
    padding: 20,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  label: {
    color: '#a1a1aa',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 10,
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#09090b',
    color: '#ffffff',
    borderRadius: 8,
    borderColor: '#27272a',
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 6,
  },
  advancedToggleText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '600',
  },
  advancedBox: {
    backgroundColor: '#09090b',
    padding: 12,
    borderRadius: 8,
    borderColor: '#27272a',
    borderWidth: 1,
    marginTop: 6,
  },
  button: {
    backgroundColor: '#38bdf8',
    borderRadius: 8,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 20,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#000000',
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 1,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 12,
    textAlign: 'center',
    fontWeight: '600',
  },
});
