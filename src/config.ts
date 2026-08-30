/**
 * Sokrat VOICE mobile — configuration.
 * Copy sensible defaults; override at build time via env or a local config.
 *
 * sipDomain   : Asterisk host name/IP (the same your web softphone uses).
 * sipWss      : WebSocket signaling endpoint (Asterisk pjsip ws / wss).
 * pushGateway : The sokrat-push-gateway base URL (used for token registration).
 * account     : SIP extension login (set by the user in Settings).
 */
export const CONFIG = {
  sipDomain: '192.168.100.128',
  sipWss: 'wss://192.168.100.128:8089/ws',
  pushGateway: 'http://192.168.100.128:8095',
  registerExpires: 120,
  apnsTopic: 'com.sokrat.voice.voip',
  appVersion: '1.0.0',
};
