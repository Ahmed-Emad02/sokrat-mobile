/**
 * Sokrat VOICE mobile — configuration.
 * Copy sensible defaults; override at build time via env or a local config.
 *
 * sipDomain   : Asterisk host name/IP (the same your web softphone uses).
 * sipWss      : WebSocket signaling endpoint (Asterisk pjsip ws / wss).
 * pushGateway : The sokrat-push-gateway base URL (used for token registration).
 * account     : SIP extension login (set by the user in Settings).
 */
export const getSipWss = (host: string, useTls = true): string => {
  if (!host) return '';
  return `${useTls ? 'wss' : 'ws'}://${host}:${useTls ? 8089 : 8088}/ws`;
};

export const getPushGateway = (host: string): string => {
  if (!host) return '';
  return `http://${host}:8095`;
};

export const CONFIG = {
  sipDomain: '',
  sipWss: '',
  pushGateway: '',
  registerExpires: 120,
  apnsTopic: 'com.sokrat.voice.voip',
  appVersion: '1.0.0',
};
