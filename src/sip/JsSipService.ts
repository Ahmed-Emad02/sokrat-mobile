/**
 * Sokrat Standalone WebRTC Softphone Signaling Engine (React Native)
 * Ported directly from Sokrat Voice softphone-core.js (JsSIP v3 + react-native-webrtc).
 */
import '../shims';
import { Platform, PermissionsAndroid } from 'react-native';
import JsSIP from 'jssip';
import { mediaDevices, MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import { CONFIG } from '../config';

try {
  JsSIP.debug.enable('JsSIP:*');
} catch {}
export type SipState =
  | 'disconnected'
  | 'connecting'
  | 'registered'
  | 'failed'
  | 'retry';

export interface ActiveCall {
  id: string;
  target: string;
  targetName: string;
  direction: 'inbound' | 'outbound';
  status: 'calling' | 'ringing' | 'active' | 'held';
  startTime?: number;
  isMuted: boolean;
  isHeld: boolean;
  session: unknown;
  remoteStream?: MediaStream | null;
}

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
  onCallEstablished: (call: ActiveCall) => void;
  onCallEnded: (callId: string, cause?: string) => void;
  onCallHoldChange?: (isHeld: boolean) => void;
}

export class JsSipService {
  private ua: JsSIP.UA | null = null;
  private currentSession: unknown = null;
  private localStream: MediaStream | null = null;
  private events: SipEvents;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private extension = '';
  private password = '';
  private serverHost = '';
  private useTls = false;

  state: SipState = 'disconnected';
  activeCall: ActiveCall | null = null;

  constructor(events: SipEvents) {
    this.events = events;
  }

  private setState(s: SipState) {
    this.state = s;
    this.events.onStateChange(s);
  }

  /**
   * Connect and register to Asterisk PJSIP.
   * Defaults to ws://<host>:8088/ws on LAN for reliable handshake without SSL cert warnings.
   */
  async connect(extension: string, password: string, host?: string, useTls = false): Promise<void> {
    this.disconnect();
    this.extension = extension;
    this.password = password;
    this.serverHost = host || CONFIG.sipDomain;
    this.useTls = useTls;
    this.setState('connecting');
    this.reconnectAttempt = 0;
    if (Platform.OS === 'android') {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO).catch(() => {});
    }
    const domain = this.serverHost;
    const protocol = this.useTls ? 'wss' : 'ws';
    const port = this.useTls ? 8089 : 8088;
    const wsUrl = `${protocol}://${domain}:${port}/ws`;

    console.log(`[sip] connecting via JsSIP to ${wsUrl} as sip:${extension}@${domain}`);

    try {
      const socket = new JsSIP.WebSocketInterface(wsUrl);
      const configuration = {
        sockets: [socket],
        uri: `sip:${extension}@${domain}`,
        password,
        authorization_user: extension,
        register: true,
        register_expires: 120,
        session_timers: false,
        connection_recovery_min_interval: 2,
        connection_recovery_max_interval: 15,
      };

      const ua = new JsSIP.UA(configuration);
      this.ua = ua;
      this.attachUaListeners(ua);
      ua.start();
      this.startKeepAlive();
    } catch (err) {
      console.error('[sip] UA init failed:', err);
      this.setState('failed');
      this.scheduleReconnect();
    }
  }

  private attachUaListeners(ua: JsSIP.UA) {
    ua.on('connecting', () => {
      console.log('[sip] connecting WebSocket...');
      if (this.state !== 'registered') {
        this.setState('connecting');
      }
    });

    ua.on('connected', () => {
      console.log('[sip] WebSocket connected, waiting for SIP registration...');
      this.reconnectAttempt = 0;
      if (this.state !== 'registered') {
        this.setState('connecting');
      }
    });

    ua.on('registered', () => {
      console.log('[sip] UA registered successfully with Asterisk');
      this.reconnectAttempt = 0;
      this.setState('registered');
    });

    ua.on('unregistered', () => {
      console.log('[sip] UA unregistered');
      if (this.state === 'registered') {
        this.setState('disconnected');
      }
    });

    ua.on('registrationFailed', (data: { response?: { status_code?: number }; cause?: string }) => {
      const code = data?.response?.status_code || 0;
      console.warn(`[sip] registration failed (code: ${code}, cause: ${data?.cause})`);
      if (code === 403) {
        this.setState('failed');
      } else {
        if (this.state !== 'registered') {
          this.setState('disconnected');
        }
      }
    });

    ua.on('disconnected', () => {
      console.log('[sip] WebSocket disconnected');
      if (this.state === 'registered') {
        this.setState('disconnected');
      }
    });
    ua.on('newRTCSession', (data: { session: unknown; originator: string }) => {
      this.handleNewRTCSession(data.session);
    });
  }

  private handleNewRTCSession(sessionObj: unknown) {
    const session = sessionObj as {
      id: string;
      direction: 'incoming' | 'outgoing';
      remote_identity?: { uri?: { user?: string }; display_name?: string };
      on: (event: string, fn: (arg?: unknown) => void) => void;
      answer: (options?: unknown) => void;
      terminate: (options?: unknown) => void;
      connection?: { getReceivers?: () => Array<{ track?: MediaStreamTrack }> };
    };

    this.currentSession = session;
    const remoteId = session.remote_identity;
    const target = remoteId?.uri?.user || 'Unknown';
    const targetName = remoteId?.display_name || target;

    const call: ActiveCall = {
      id: session.id || String(Date.now()),
      target,
      targetName,
      direction: session.direction === 'incoming' ? 'inbound' : 'outbound',
      status: session.direction === 'incoming' ? 'ringing' : 'calling',
      isMuted: false,
      isHeld: false,
      session,
      remoteStream: null,
    };

    this.activeCall = call;

    // Attach peerconnection remote audio track listeners
    session.on('peerconnection', (data: unknown) => {
      const pc = (data as { peerconnection?: unknown })?.peerconnection as {
        addEventListener?: (event: string, fn: (evt: unknown) => void) => void;
      } | undefined;

      if (pc && typeof pc.addEventListener === 'function') {
        pc.addEventListener('track', (eventObj: unknown) => {
          const event = eventObj as { track?: MediaStreamTrack; streams?: MediaStream[] };
          console.log('[sip] remote audio track received:', event?.track);
          if (event?.track) {
            event.track.enabled = true;
          }
          if (event?.streams && event.streams[0] && this.activeCall) {
            this.activeCall.remoteStream = event.streams[0];
          }
        });
        pc.addEventListener('addstream', (eventObj: unknown) => {
          const event = eventObj as { stream?: MediaStream };
          console.log('[sip] remote stream added:', event?.stream);
          if (event?.stream && this.activeCall) {
            this.activeCall.remoteStream = event.stream;
          }
        });
      }
    });

    // Attach session-level listeners
    session.on('progress', () => {
      if (this.activeCall) {
        this.activeCall.status = 'calling';
      }
      this.attachEarlyMediaAudio(session);
    });

    session.on('accepted', () => {
      if (this.activeCall) {
        this.activeCall.status = 'active';
        this.activeCall.startTime = Date.now();
        this.events.onCallEstablished(this.activeCall);
      }
      this.attachEarlyMediaAudio(session);
    });

    session.on('confirmed', () => {
      if (this.activeCall) {
        this.activeCall.status = 'active';
        if (!this.activeCall.startTime) this.activeCall.startTime = Date.now();
        this.events.onCallEstablished(this.activeCall);
      }
      this.attachEarlyMediaAudio(session);
    });

    session.on('ended', (evt: unknown) => {
      const cause = (evt as { cause?: string })?.cause || 'NORMAL_CLEARING';
      const callId = this.activeCall?.id || '';
      this.activeCall = null;
      this.currentSession = null;
      this.events.onCallEnded(callId, cause);
    });

    session.on('failed', (evt: unknown) => {
      const cause = (evt as { cause?: string })?.cause || 'REJECTED';
      const callId = this.activeCall?.id || '';
      this.activeCall = null;
      this.currentSession = null;
      this.events.onCallEnded(callId, cause);
    });

    session.on('hold', () => {
      if (this.activeCall) {
        this.activeCall.isHeld = true;
        this.events.onCallHoldChange?.(true);
      }
    });

    session.on('unhold', () => {
      if (this.activeCall) {
        this.activeCall.isHeld = false;
        this.events.onCallHoldChange?.(false);
      }
    });

    if (session.direction === 'incoming') {
      const info: IncomingCallInfo = {
        type: 'incoming-call',
        callerId: target,
        callerName: targetName,
        extension: this.extension,
        timestamp: Date.now(),
      };
      this.events.onIncomingCall(info);
    }
  }

  private attachEarlyMediaAudio(session: { connection?: { getReceivers?: () => Array<{ track?: MediaStreamTrack }> } }) {
    try {
      const pc = session.connection;
      if (pc && typeof pc.getReceivers === 'function') {
        const receivers = pc.getReceivers();
        const tracks: MediaStreamTrack[] = [];
        for (const r of receivers) {
          if (r.track) tracks.push(r.track);
        }
        if (tracks.length > 0) {
          const stream = new MediaStream(tracks);
          if (this.activeCall) {
            this.activeCall.remoteStream = stream;
          }
        }
      }
    } catch (err) {
      console.warn('[sip] early media audio stream setup warning:', err);
    }
  }

  /**
   * Acquire local microphone audio stream with echo cancellation and auto gain control.
   */
  private async getLocalAudioStream(): Promise<MediaStream | null> {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          console.warn('[sip] RECORD_AUDIO permission denied');
          return null;
        }
      }
      const stream = (await mediaDevices.getUserMedia({
        audio: true,
        video: false,
      })) as unknown as MediaStream;
      const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
      for (const t of tracks) {
        t.enabled = true;
      }
      console.log('[sip] acquired local microphone audio stream, tracks:', tracks.length);
      return stream;
    } catch (err) {
      console.warn('[sip] failed to acquire local audio stream:', err);
      return null;
    }
  }

  /**
   * Place an outbound call to a SIP extension or PSTN number.
   */
  async call(target: string): Promise<void> {
    if (!this.ua || !this.ua.isRegistered()) {
      throw new Error('Softphone is not registered');
    }

    const localStream = await this.getLocalAudioStream();
    this.localStream = localStream;
    const domain = this.serverHost || CONFIG.sipDomain;
    const targetUri = `sip:${target}@${domain}`;

    const options: Record<string, unknown> = {
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
      sessionTimersExpires: 120,
    };

    if (localStream) {
      options.mediaStream = localStream;
    }

    try {
      this.ua.call(targetUri, options);
    } catch (err) {
      console.error('[sip] outbound call dispatch failed:', err);
      throw err;
    }
  }

  /**
   * Answer incoming call session.
   */
  async answer(): Promise<boolean> {
    const session = this.currentSession as { answer?: (opt?: unknown) => void } | null;
    if (!session || typeof session.answer !== 'function') return false;

    const localStream = await this.getLocalAudioStream();
    this.localStream = localStream;
    const options: Record<string, unknown> = {
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
    };

    if (localStream) {
      options.mediaStream = localStream;
    }

    try {
      session.answer(options);
      return true;
    } catch (err) {
      console.error('[sip] answer call failed:', err);
      return false;
    }
  }

  /**
   * Terminate/hangup active call.
   */
  async hangup(): Promise<void> {
    if (this.localStream) {
      try {
        const tracks = this.localStream.getTracks ? this.localStream.getTracks() : [];
        for (const t of tracks) {
          t.stop();
        }
      } catch {}
      this.localStream = null;
    }
    const session = this.currentSession as { terminate?: () => void } | null;
    if (session && typeof session.terminate === 'function') {
      try {
        session.terminate();
      } catch {}
    }
    this.currentSession = null;
    this.activeCall = null;
  }

  /**
   * Decline incoming call.
   */
  async decline(): Promise<void> {
    await this.hangup();
  }

  /**
   * Toggle Mute / Unmute.
   */
  toggleMute(): boolean {
    const session = this.currentSession as { mute?: (opt: unknown) => void; unmute?: (opt: unknown) => void } | null;
    if (!session || !this.activeCall) return false;

    if (this.activeCall.isMuted) {
      session.unmute?.({ audio: true });
      this.activeCall.isMuted = false;
    } else {
      session.mute?.({ audio: true });
      this.activeCall.isMuted = true;
    }
    return this.activeCall.isMuted;
  }

  /**
   * Toggle Hold / Unhold.
   */
  toggleHold(): boolean {
    const session = this.currentSession as { hold?: () => void; unhold?: () => void } | null;
    if (!session || !this.activeCall) return false;

    if (this.activeCall.isHeld) {
      session.unhold?.();
      this.activeCall.isHeld = false;
    } else {
      session.hold?.();
      this.activeCall.isHeld = true;
    }
    return this.activeCall.isHeld;
  }

  /**
   * Send in-call DTMF tone.
   */
  sendDTMF(digit: string): void {
    const session = this.currentSession as { sendDTMF?: (tone: string) => void } | null;
    if (session && typeof session.sendDTMF === 'function') {
      try {
        session.sendDTMF(digit);
      } catch (err) {
        console.warn('[sip] sendDTMF failed:', err);
      }
    }
  }

  /**
   * Blind transfer active call to target extension.
   */
  blindTransfer(target: string): void {
    const session = this.currentSession as { refer?: (target: string) => void } | null;
    if (session && typeof session.refer === 'function') {
      const domain = this.serverHost || CONFIG.sipDomain;
      const targetUri = `sip:${target}@${domain}`;
      session.refer(targetUri);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.state === 'failed' || !this.extension || !this.password) return;

    this.reconnectAttempt++;
    const backoff = Math.min(30, Math.pow(2, Math.min(4, this.reconnectAttempt)));
    this.reconnectTimer = setTimeout(() => {
      if (!this.ua || !this.ua.isRegistered()) {
        this.connect(this.extension, this.password, this.serverHost, this.useTls).catch(() => {});
      }
    }, backoff * 1000);
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      try {
        const socket = (this.ua as unknown as { _transport?: { _ws?: { send?: (data: string) => void } } })?._transport?._ws;
        socket?.send?.('\r\n\r\n');
      } catch {}
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
    if (this.ua) {
      try {
        this.ua.stop();
      } catch {}
      this.ua = null;
    }
    this.currentSession = null;
    this.activeCall = null;
    this.setState('disconnected');
  }

  isRegistered() {
    return this.state === 'registered';
  }
}
