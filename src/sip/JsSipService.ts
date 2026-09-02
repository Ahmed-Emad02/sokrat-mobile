/**
 * Sokrat Standalone WebRTC Softphone Signaling Engine (React Native)
 * Ported directly from Sokrat Voice softphone-core.js (JsSIP v3 + react-native-webrtc).
 */
import '../shims';
import { Platform, PermissionsAndroid } from 'react-native';
import JsSIP from 'jssip';
import { mediaDevices, MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import { CONFIG } from '../config';
import { startCallManagers } from '../calls/incall';
import { CodecPreference } from '../storage/store';

const CALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  callId: string;
  nativePresented?: boolean;
}

export interface SipEvents {
  onStateChange: (state: SipState) => void;
  onIncomingCall: (info: IncomingCallInfo) => void;
  onCallEstablished: (call: ActiveCall) => void;
  onCallEnded: (callId: string, cause?: string) => void;
  onCallHoldChange?: (isHeld: boolean) => void;
  onCallMuteChange?: (isMuted: boolean) => void;
}
export class JsSipService {
  private ua: JsSIP.UA | null = null;
  private currentSession: unknown = null;
  private preferredCodec: CodecPreference = 'auto';

  setPreferredCodec(codec: CodecPreference): void {
    this.preferredCodec = codec;
    console.log(`[sip] preferred audio codec set to: ${codec}`);
  }

  private readonly events: SipEvents;
  private localStream: MediaStream | null = null;
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
    const targetHost = host || CONFIG.sipDomain;
    if (
      this.isConnectedOrConnecting() &&
      this.extension === extension &&
      this.password === password &&
      this.serverHost === targetHost &&
      this.useTls === useTls
    ) {
      return;
    }
    this.disconnect();
    this.extension = extension;
    this.password = password;
    this.serverHost = targetHost;
    this.useTls = useTls;
    this.setState('connecting');
    this.reconnectAttempt = 0;
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
    ua.on('newRTCSession', (data: { session: unknown; originator: string; request?: unknown }) => {
      this.handleNewRTCSession(data.session, data.request);
    });
  }

  private handleNewRTCSession(sessionObj: unknown, requestObj?: unknown) {
    const session = sessionObj as {
      id: string;
      direction: 'incoming' | 'outgoing';
      remote_identity?: { uri?: { user?: string }; display_name?: string };
      request?: { getHeader?: (name: string) => string | undefined };
      _request?: { getHeader?: (name: string) => string | undefined; headers?: Record<string, Array<{ raw: string }>> };
      on: (event: string, fn: (arg?: unknown) => void) => void;
      answer: (options?: unknown) => void;
      terminate: (options?: unknown) => void;
      connection?: { getReceivers?: () => Array<{ track?: MediaStreamTrack }> };
    };
    const req = (requestObj || session._request || session.request) as {
      getHeader?: (name: string) => string | undefined;
      headers?: Record<string, Array<{ raw: string }>>;
    } | undefined;

    const incomingCallId = session.direction === 'incoming'
      ? (req?.getHeader?.('X-Sokrat-Call-ID') ||
         req?.getHeader?.('x-sokrat-call-id') ||
         req?.headers?.['X-Sokrat-Call-Id']?.[0]?.raw)?.trim()
      : undefined;
    if (session.direction === 'incoming' &&
        (!incomingCallId || !CALL_ID_PATTERN.test(incomingCallId))) {
      console.error(`[sip] rejected inbound INVITE with invalid callId=${incomingCallId || 'missing'}`);
      try {
        session.terminate({
          status_code: 400,
          reason_phrase: 'Missing or invalid X-Sokrat-Call-ID',
        });
      } catch {}
      return;
    }
    this.currentSession = session;
    const remoteId = session.remote_identity;
    const target = remoteId?.uri?.user || 'Unknown';
    const targetName = remoteId?.display_name || target;
    const callId = incomingCallId || session.id || String(Date.now());

    const call: ActiveCall = {
      id: callId,
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

    // Intercept local SDP to prioritize user's preferred audio codec and enable FEC
    const rtcSession = session as {
      on?: (event: string, fn: (data: unknown) => void) => void;
    };
    rtcSession.on?.('sdp', (evt: unknown) => {
      const data = evt as { originator?: string; type?: string; sdp?: string };
      if (data && data.originator === 'local' && data.sdp) {
        data.sdp = this.prioritizeCodecInSdp(data.sdp, this.preferredCodec);
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
      console.log(`[sip][callId=${call.id}] session accepted; waiting for confirmation`);
      this.attachEarlyMediaAudio(session);
    });

    session.on('confirmed', () => {
      if (this.activeCall?.id === call.id) {
        this.activeCall.status = 'active';
        if (!this.activeCall.startTime) this.activeCall.startTime = Date.now();
        console.log(`[sip][callId=${call.id}] session confirmed`);
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
        callId,
      };
      console.log(`[sip][callId=${callId}] matched inbound INVITE`);
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
    if (Platform.OS === 'android') {
      const hasPermission = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (!hasPermission) {
        console.warn('[sip] microphone permission is not granted');
        return null;
      }
    }

    const { promise, resolve } = Promise.withResolvers<MediaStream | null>();
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      console.warn('[sip] microphone acquisition timed out after 3000ms');
      resolve(null);
    }, 3000);
    // 1. Ensure phone audio mode is in communication mode (VOICE_COMMUNICATION)
    // before capturing the microphone so Android HAL attaches the hardware voice mic,
    // acoustic echo canceler, and noise suppressor.
    startCallManagers();

    // 2. Explicit voice-processing constraints for WebRTC Audio Processing Module (APM)
    const audioConstraints: Record<string, unknown> = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      googEchoCancellation: true,
      googNoiseSuppression: true,
      googAutoGainControl: true,
      googHighpassFilter: true,
      googAudioMirroring: false,
    };

    mediaDevices
      .getUserMedia({ audio: audioConstraints, video: false })
      .then((value) => {
        const stream = value as unknown as MediaStream;
        if (finished) {
          stream.getTracks?.().forEach((track: MediaStreamTrack) => track.stop());
          return;
        }
        finished = true;
        clearTimeout(timer);
        const tracks = stream.getAudioTracks?.() || [];
        tracks.forEach((track: MediaStreamTrack) => { track.enabled = true; });
        console.log(`[sip] microphone acquired tracks=${tracks.length}`);
        resolve(tracks.length > 0 ? stream : null);
      })
      .catch((error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        console.warn('[sip] microphone acquisition failed:', error);
        resolve(null);
      });

    return promise;
  }

  /**
   * Place an outbound call to a SIP extension or PSTN number.
   */
  async call(target: string): Promise<void> {
    if (!this.ua || !this.ua.isRegistered()) {
      throw new Error('Softphone is not registered');
    }

    const localStream = await this.getLocalAudioStream();
    if (!localStream) throw new Error('Microphone unavailable');
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
  async answer(callId: string): Promise<boolean> {
    const session = this.currentSession as { answer?: (opt?: unknown) => void } | null;
    if (!session ||
        typeof session.answer !== 'function' ||
        this.activeCall?.id !== callId ||
        this.activeCall.direction !== 'inbound') {
      return false;
    }

    const localStream = await this.getLocalAudioStream();
    if (!localStream) {
      console.error(`[sip][callId=${callId}] answer blocked: microphone unavailable`);
      return false;
    }
    this.localStream = localStream;
    const options: Record<string, unknown> = {
      mediaConstraints: { audio: true, video: false },
      mediaStream: localStream,
      pcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
    };

    try {
      session.answer(options);
      this.activeCall.status = 'active';
      if (!this.activeCall.startTime) this.activeCall.startTime = Date.now();
      console.log(`[sip][callId=${callId}] answer dispatched -> active call established`);
      this.events.onCallEstablished(this.activeCall);
      return true;
    } catch (error) {
      localStream.getTracks?.().forEach((track) => track.stop());
      this.localStream = null;
      console.error(`[sip][callId=${callId}] answer failed:`, error);
      return false;
    }
  }

  /**
   * Terminate/hangup active call.
   */
  async hangup(): Promise<void> {
    if (this.activeCall?.status === 'ringing' && this.activeCall?.direction === 'inbound') {
      await this.decline(this.activeCall.id);
      return;
    }
    if (this.localStream) {
      try {
        const tracks = this.localStream.getTracks ? this.localStream.getTracks() : [];
        for (const t of tracks) {
          t.stop();
        }
      } catch {}
      this.localStream = null;
    }
    const session = this.currentSession as { terminate?: (opts?: unknown) => void } | null;
    if (session && typeof session.terminate === 'function') {
      try {
        session.terminate();
      } catch {}
    }
    this.currentSession = null;
    this.activeCall = null;
  }

  /**
   * Decline incoming call with explicit SIP 603 Decline.
   */
  async decline(callId?: string): Promise<boolean> {
    if (!this.activeCall ||
        (callId && this.activeCall.id !== callId) ||
        this.activeCall.direction !== 'inbound') {
      return false;
    }
    if (this.localStream) {
      try {
        this.localStream.getTracks?.().forEach((track) => track.stop());
      } catch {}
      this.localStream = null;
    }
    const session = this.currentSession as { terminate?: (opts?: unknown) => void } | null;
    if (!session || typeof session.terminate !== 'function') return false;
    try {
      session.terminate({
        status_code: 603,
        reason_phrase: 'Decline',
      });
      console.log(`[sip][callId=${this.activeCall.id}] decline dispatched`);
    } catch (error) {
      console.warn(`[sip][callId=${this.activeCall.id}] decline failed:`, error);
      return false;
    }
    this.currentSession = null;
    this.activeCall = null;
    return true;
  }

  toggleMute(): boolean {
    const session = this.currentSession as { mute?: (opt: unknown) => void; unmute?: (opt: unknown) => void } | null;
    if (!this.activeCall) return false;

    const nextMuted = !this.activeCall.isMuted;
    this.activeCall.isMuted = nextMuted;

    if (session) {
      if (nextMuted) {
        session.mute?.({ audio: true });
      } else {
        session.unmute?.({ audio: true });
      }
    }

    if (this.localStream) {
      try {
        const tracks = this.localStream.getAudioTracks ? this.localStream.getAudioTracks() : [];
        tracks.forEach((t) => {
          t.enabled = !nextMuted;
        });
      } catch {}
    }

    this.events.onCallMuteChange?.(nextMuted);
    return nextMuted;
  }

  toggleHold(): boolean {
    const session = this.currentSession as { hold?: () => void; unhold?: () => void } | null;
    if (!this.activeCall) return false;

    const nextHeld = !this.activeCall.isHeld;
    this.activeCall.isHeld = nextHeld;

    if (session) {
      if (nextHeld) {
        session.hold?.();
      } else {
        session.unhold?.();
      }
    }

    this.events.onCallHoldChange?.(nextHeld);
    return nextHeld;
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

  isRegistered(): boolean {
    return this.state === 'registered';
  }

  isConnectedOrConnecting(): boolean {
    return this.state === 'registered' || this.state === 'connecting';
  }

  /**
   * Reorder audio payload types in local SDP so the user's preferred codec
   * is placed at highest priority, and ensure inband FEC is enabled for Opus.
   */
  private prioritizeCodecInSdp(sdp: string, preferred: CodecPreference): string {
    if (!sdp) return sdp;

    const lines = sdp.split('\r\n');
    const targetCodec = preferred.toLowerCase();

    // 1. Build payload-to-codec mapping from rtpmap attributes
    const payloadToCodec: Record<string, string> = {
      '0': 'pcmu',
      '8': 'pcma',
      '9': 'g722',
    };

    for (const line of lines) {
      const match = /^a=rtpmap:(\d+)\s+([\w-]+)\//i.exec(line);
      if (match) {
        payloadToCodec[match[1]] = match[2].toLowerCase();
      }
    }

    let targetPayload: string | null = null;
    if (preferred !== 'auto') {
      for (const [pt, codecName] of Object.entries(payloadToCodec)) {
        if (codecName === targetCodec) {
          targetPayload = pt;
          break;
        }
      }
    }

    // 2. Reorder m=audio line if a target payload is selected
    const updatedLines = lines.map((line) => {
      if (targetPayload && line.startsWith('m=audio ')) {
        const parts = line.split(' ');
        if (parts.length > 3) {
          const prefix = parts.slice(0, 3);
          const payloads = parts.slice(3);
          const remaining = payloads.filter((p) => p !== targetPayload);
          const reordered = [targetPayload, ...remaining];
          return `${prefix.join(' ')} ${reordered.join(' ')}`;
        }
      }
      return line;
    });

    // 3. For Opus, ensure inband FEC (useinbandfec=1) is active for packet loss protection
    const opusPayload = Object.entries(payloadToCodec).find(([, name]) => name === 'opus')?.[0];
    if (opusPayload) {
      for (let i = 0; i < updatedLines.length; i++) {
        if (updatedLines[i].startsWith(`a=fmtp:${opusPayload} `)) {
          if (!updatedLines[i].includes('useinbandfec=1')) {
            updatedLines[i] = `${updatedLines[i]};useinbandfec=1`;
          }
        }
      }
    }

    return updatedLines.join('\r\n');
  }
}
