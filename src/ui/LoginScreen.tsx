/**
 * Sokrat VOICE — Login / Authentication Screen.
 * Full-screen standalone sign-in view.
 */
import React, { useState, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, themedStyles } from '../theme';
import { useI18n } from '../i18n';
import { CONFIG } from '../config';
import { SettingsIcon, PhoneIcon } from './Icons';

type Props = {
  onLogin: (ext: string, password: string, serverHost: string, fallbackHost?: string) => void;
  state: string;
  /** Optional status/error line (e.g. gateway approval pending). */
  message?: string | null;
};

const LOGIN_OVERRIDES = {
  logoBadge: { borderColor: 'brand' as const },
  logoSubtitle: { color: 'brand' as const },
  buttonText: { color: 'onBrand' as const },
};

export function LoginScreen({ onLogin, state, message }: Props) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => themedStyles(rawStyles, colors, LOGIN_OVERRIDES), [colors]);
  const [extension, setExtension] = useState('');
  const [password, setPassword] = useState('');
  const [serverHost, setServerHost] = useState(CONFIG.sipDomain || '');
  const [fallbackHost, setFallbackHost] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(!CONFIG.sipDomain);

  const submit = () => {
    if (!serverHost.trim()) {
      setShowAdvanced(true);
      return;
    }
    if (!extension.trim() || !password.trim()) return;
    onLogin(extension.trim(), password.trim(), serverHost.trim(), fallbackHost.trim() || undefined);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {/* Brand Header */}
        <View style={styles.brandContainer}>
          <View style={styles.logoBadge}>
            <PhoneIcon size={20} color={colors.brand} />
          </View>
          <View>
            <Text style={styles.logoTitle}>SOKRAT</Text>
            <Text style={styles.logoSubtitle}>VOICE · PJSIP Mobile</Text>
          </View>
        </View>

        {/* Form Card */}
        <View style={styles.card}>
          <Text style={styles.label}>{t('SIP EXTENSION')}</Text>
          <TextInput
            style={styles.input}
            value={extension}
            onChangeText={setExtension}
            placeholder="e.g. 150"
            placeholderTextColor={colors.textFaint}
            keyboardType="number-pad"
          />

          <Text style={styles.label}>{t('SIP PASSWORD')}</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="SIP Secret"
            placeholderTextColor={colors.textFaint}
            secureTextEntry
          />

          {/* Expandable PBX Server Host Config */}
          <TouchableOpacity
            style={styles.advancedToggle}
            onPress={() => setShowAdvanced(!showAdvanced)}
          >
            <SettingsIcon size={14} color={colors.brand} />
            <Text style={styles.advancedToggleText}>
              {showAdvanced ? t('Hide Server Settings') : (serverHost ? `${t('Server:')} ${serverHost}` : t('Configure Server'))}
            </Text>
          </TouchableOpacity>

          {showAdvanced && (
            <View style={styles.advancedBox}>
              <Text style={styles.label}>{t('PBX HOST / IP ADDRESS')}</Text>
              <TextInput
                style={styles.input}
                value={serverHost}
                onChangeText={setServerHost}
                placeholder="e.g. pbx.yourcompany.com"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.label}>{t('LOCAL FALLBACK GATEWAY (OPTIONAL)')}</Text>
              <TextInput
                style={styles.input}
                value={fallbackHost}
                onChangeText={setFallbackHost}
                placeholder="e.g. 192.168.100.50:18080"
                placeholderTextColor={colors.textFaint}
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
              {state === 'connecting' ? t('CONNECTING…') : t('SIGN IN')}
            </Text>
          </TouchableOpacity>

          {message ? (
            <Text style={[styles.errorText, state === 'connecting' && styles.statusText]}>
              {t(message)}
            </Text>
          ) : state === 'failed' ? (
            <Text style={styles.errorText}>
              {t('Connection failed. Please check host and extension secret.')}
            </Text>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const rawStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  content: {
    width: '100%',
  },
  brandContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  logoBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#18181b',
    borderColor: '#10b981',
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoTitle: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 2,
  },
  logoSubtitle: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 2,
  },
  card: {
    paddingHorizontal: 0,
    paddingVertical: 0,
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
  statusText: {
    color: '#38bdf8',
  },
});
