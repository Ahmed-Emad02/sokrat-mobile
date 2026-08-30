/**
 * Sokrat VOICE mobile SIP signaling service.
 *
 * Runs sip.js (the maintained successor to JsSIP) inside React Native by
 * shimming the DOM WebRTC globals with react-native-webrtc's native
 * libwebrtc bindings. Handles registration to Asterisk over WSS and
 * incoming/outgoing call sessions — mirroring the web softphone-core.js
 * signaling contract (sip:EXT@DOMAIN, register_expires 120, ws keep-alive).
 *
 * IMPORTANT (RN shim): sip.js expects browser globals
 *   - globalThis.RTCPeerConnection  -> react-native-webrtc
 *   - globalThis.RTCSessionDescription / RTCIceCandidate
 *   - globalThis.navigator.mediaDevices
 * We reassign these at import time. Media capture stays native via
 * react-native-webrtc's MediaStream so call audio is bridged natively.
 */
import { registerGlobals, mediaDevices } from 'react-native-webrtc';
import { UserAgent, Registerer, Invitation, Session } from 'sip.js';
import { CONFIG } from '../config';

// Register WebRTC DOM globals required by sip.js
registerGlobals();
const g = globalThis as Record<string, unknown>;
g.window = g.window || g;
export type SipState =
  | 'disconnected'
  | 'connecting'
  | 'registered'
  | 'failed'
  | 'retry';

export interface IncomingCallInfo {
  type: 'incoming-call';
  callerId: string;
  callerName: string;
  extension: string;
  timestamp: number;
  sipWss?: string;
}

export interface SipEvents {
  onStateChange: (state: SipState) => void;
  onIncomingCall: (info: IncomingCallInfo) => void;
  onCallEnded: (callId: string) => void;
  onCallEstablished: (callId: string) => void;
}

export class SipService {
  private ua: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private session: Session | null = null;
  private events: SipEvents;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private extension = '';

  state: SipState = 'disconnected';

  constructor(events: SipEvents) {
    this.events = events;
  }

  /**
   * Wake-on-push: open a fresh WebSocket and register the extension.
   * Called both on normal login and from the PushKit/FCM cold-start path.
   */
  async connect(extension: string, password: string): Promise<void> {
    this.disconnect();
    this.extension = extension;
    this.setState('connecting');
    this.reconnectAttempt = 0;

    // Priming native WebRTC media lets sip.js's SessionDescriptionHandler
    // reuse an already-granted audio permission on cold start.
    try {
      await mediaDevices.getUserMedia({ audio: true });
    } catch (_) {}

    const uri = UserAgent.makeURI(`sip:${extension}@${CONFIG.sipDomain}`);
    if (!uri) {
      this.setState('failed');
      throw new Error('Invalid SIP URI');
    }

    const uaOptions: any = {
      uri,
      authorizationPassword: password,
      transportOptions: { server: CONFIG.sipWss },
      logConfiguration: false,
      logLevel: 'warn',
      hackWssInTransport: true,
      delegate: {
        onInvite: (invitation: Invitation) => this.handleIncoming(invitation),
        onConnect: () => {},
        onDisconnect: () => {},
      },
    };

    this.ua = new UserAgent(uaOptions);

    try {
      await this.ua.start();
      this.registerer = new Registerer(this.ua, { expires: CONFIG.registerExpires });
      this.registerer.stateChange.addListener(() => {
        const state = this.registerer?.state;
        if (state === 'Registered') {
          this.reconnectAttempt = 0;
          this.setState('registered');
        } else if (state === 'Unregistered' && this.state !== 'failed') {
          this.setState('disconnected');
          this.events.onStateChange(this.state);
        } else if (state === 'Terminated') {
          this.scheduleReconnect(extension, password);
        }
      });
      await this.registerer.register();
      this.startKeepAlive();
    } catch (err) {
      console.error('[sip] connect failed:', err);
      this.setState('failed');
      this.scheduleReconnect(extension, password);
    }
  }

  private setState(s: SipState) {
    this.state = s;
    this.events.onStateChange(s);
  }

  private handleIncoming(invitation: Invitation) {
    this.session = invitation;
    const id = invitation.remoteIdentity;
    const callerId = id?.uri?.user || '';
    const callerName = id?.displayName || callerId;
    const info: IncomingCallInfo = {
      type: 'incoming-call',
      callerId,
      callerName,
      extension: '', // filled by the push payload when present
      timestamp: Date.now(),
    };
    this.events.onIncomingCall(info);
  }

  async answer() {
    const inv = this.session as Invitation | null;
    if (!inv || typeof inv.accept !== 'function') return false;
    try {
      await inv.accept({
        sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
      });
      this.events.onCallEstablished('active');
      return true;
    } catch (err) {
      console.error('[sip] answer failed:', err);
      return false;
    }
  }

  async hangup() {
    const sess = this.session as any;
    if (!sess) return;
    try {
      if (sess.state === 'Established') {
        await sess.bye();
      } else if (typeof sess.cancel === 'function') {
        await sess.cancel();
      } else {
        await sess.terminate?.();
      }
    } catch (_) {}
    this.session = null;
  }

  async decline() {
    const inv = this.session as any;
    if (inv) {
      try {
        await (inv.decline ? inv.decline() : inv.terminate?.());
      } catch (_) {}
    }
    this.session = null;
  }

  async call(target: string) {
    if (!this.ua) throw new Error('Not registered');
    const uri = UserAgent.makeURI(`sip:${target}@${CONFIG.sipDomain}`);
    if (!uri) throw new Error('Invalid target');
    const inviter = new (require('sip.js').Inviter)(this.ua, uri, {
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    this.session = inviter;
    await inviter.invite();
  }

  private scheduleReconnect(extension: string, password: string) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempt++;
    const backoff = Math.min(30, Math.pow(2, Math.min(5, this.reconnectAttempt)));
    this.reconnectTimer = setTimeout(() => {
      this.connect(extension, password).catch(() => {});
    }, backoff * 1000);
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      // SIP over WebSocket keep-alive equivalent to the web softphone's
      // '\r\n\r\n' ping via the transport socket.
      try {
        (this.ua as any)?.userAgentCore?.transport?.send?.('\r\n\r\n');
      } catch (_) {}
    }, 20000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepAlive();
    if (this.registerer) {
      try {
        this.registerer.dispose();
      } catch (_) {}
      this.registerer = null;
    }
    if (this.ua) {
      try {
        this.ua.stop();
      } catch (_) {}
      this.ua = null;
    }
    this.session = null;
    this.setState('disconnected');
  }

  isRegistered() {
    return this.state === 'registered';
  }
}
