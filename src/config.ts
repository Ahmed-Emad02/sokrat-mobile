/**
 * Sokrat VOICE mobile — configuration.
 * Copy sensible defaults; override at build time via env or a local config.
 *
 * sipDomain   : Asterisk host name/IP (the same your web softphone uses).
 * sipWss      : WebSocket signaling endpoint (Asterisk pjsip ws / wss).
 * pushGateway : The sokrat-push-gateway base URL (used for token registration).
 * account     : SIP extension login (set by the user in Settings).
 */
import { NativeModules, Platform } from 'react-native';
import { gatewayBaseUrl } from './gateway/urls';

export const getSipWss = (host: string, useTls = false): string => {
  if (!host) return '';
  return `${useTls ? 'wss' : 'ws'}://${host}:${useTls ? 8089 : 8088}/ws`;
};

export const getPushGateway = (host: string): string => {
  return gatewayBaseUrl(host);
};

export async function hydrateAppVersion(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const module = NativeModules.CallNotificationModule;
    if (!module?.getAppVersion) return;
    const info = await module.getAppVersion();
    if (info && typeof info.versionName === 'string' && info.versionName.trim()) {
      CONFIG.appVersion = info.versionName.trim();
    }
  } catch {
    // The static fallback is retained if the native package metadata is unavailable.
  }
}

export const CONFIG = {
  sipDomain: '',
  sipWss: '',
  pushGateway: '',
  registerExpires: 120,
  apnsTopic: 'com.sokrat.voice.voip',
  appVersion: '1.0.15',
};
