import React, { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../theme';
import { SipState } from '../sip/JsSipService';

type Props = {
  extension: string;
  serverHost: string;
  useTls: boolean;
  state: SipState;
  isDnd: boolean;
  isAutoAnswer: boolean;
  onSaveServer: (host: string, useTls: boolean) => void;
  onToggleDnd: (val: boolean) => void;
  onToggleAutoAnswer: (val: boolean) => void;
  onLogout: () => void;
};

export function SettingsTab({
  extension,
  serverHost,
  useTls,
  state,
  isDnd,
  isAutoAnswer,
  onSaveServer,
  onToggleDnd,
  onToggleAutoAnswer,
  onLogout,
}: Props) {
  const [hostInput, setHostInput] = useState(serverHost);
  const [tlsInput, setTlsInput] = useState(useTls);
  const [savedFeedback, setSavedFeedback] = useState(false);

  const handleSave = () => {
    if (!hostInput.trim()) return;
    onSaveServer(hostInput.trim(), tlsInput);
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 2000);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Account Info Box */}
      <View style={styles.card}>
        <Text style={styles.cardHeader}>ACCOUNT INFORMATION</Text>
        <View style={styles.row}>
          <Text style={styles.label}>SIP Extension</Text>
          <Text style={styles.value}>{extension}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Status</Text>
          <Text
            style={[
              styles.value,
              { color: state === 'registered' ? COLORS.accent : COLORS.warn },
            ]}
          >
            {state === 'registered' ? 'Registered ✓' : state.toUpperCase()}
          </Text>
        </View>
      </View>

      {/* PBX Server Config Box */}
      <View style={styles.card}>
        <Text style={styles.cardHeader}>PBX SERVER SETTINGS</Text>

        <Text style={styles.fieldLabel}>SERVER HOST / IP</Text>
        <TextInput
          style={styles.input}
          value={hostInput}
          onChangeText={setHostInput}
          placeholder="e.g. 192.168.100.128"
          placeholderTextColor={COLORS.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <View style={[styles.row, { marginTop: 12 }]}>
          <View>
            <Text style={styles.label}>Secure WebSocket (WSS)</Text>
            <Text style={styles.subtext}>
              {tlsInput ? 'Port 8089 (WSS TLS)' : 'Port 8088 (Plain WS - recommended for LAN)'}
            </Text>
          </View>
          <Switch
            value={tlsInput}
            onValueChange={setTlsInput}
            thumbColor={tlsInput ? COLORS.accent : COLORS.surface}
            trackColor={{ false: COLORS.surface, true: '#064e3b' }}
          />
        </View>

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>
            {savedFeedback ? 'Saved & Reconnecting ✓' : 'Save & Apply Server'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Preferences Box */}
      <View style={styles.card}>
        <Text style={styles.cardHeader}>CALL PREFERENCES</Text>
        <View style={styles.row}>
          <View>
            <Text style={styles.label}>Do Not Disturb (DND)</Text>
            <Text style={styles.subtext}>Reject incoming calls automatically</Text>
          </View>
          <Switch
            value={isDnd}
            onValueChange={onToggleDnd}
            thumbColor={isDnd ? COLORS.danger : COLORS.surface}
            trackColor={{ false: COLORS.surface, true: '#450a0a' }}
          />
        </View>

        <View style={[styles.row, { marginTop: 16 }]}>
          <View>
            <Text style={styles.label}>Auto-Answer Calls</Text>
            <Text style={styles.subtext}>Automatically accept incoming calls</Text>
          </View>
          <Switch
            value={isAutoAnswer}
            onValueChange={onToggleAutoAnswer}
            thumbColor={isAutoAnswer ? COLORS.accent : COLORS.surface}
            trackColor={{ false: COLORS.surface, true: '#064e3b' }}
          />
        </View>
      </View>

      {/* Sign Out Button */}
      <TouchableOpacity style={styles.logoutBtn} onPress={onLogout}>
        <Text style={styles.logoutBtnText}>SIGN OUT OF EXTENSION {extension}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    padding: 16,
    gap: 16,
    paddingBottom: 32,
  },
  card: {
    backgroundColor: COLORS.bgElevated,
    borderRadius: 12,
    borderColor: COLORS.border,
    borderWidth: 1,
    padding: 16,
  },
  cardHeader: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  value: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '700',
  },
  subtext: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  fieldLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.bg,
    color: COLORS.text,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  saveBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  saveBtnText: {
    color: '#0f172a',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  logoutBtn: {
    backgroundColor: '#450a0a',
    borderColor: COLORS.danger,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  logoutBtnText: {
    color: COLORS.danger,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
