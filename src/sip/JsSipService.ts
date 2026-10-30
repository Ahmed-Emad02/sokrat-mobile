/**
 * Sokrat Standalone WebRTC Softphone Signaling Engine (React Native)
 * Ported directly from Sokrat Voice softphone-core.js (JsSIP v3 + react-native-webrtc).
 */
import '../shims';
import { Platform, PermissionsAndroid } from 'react-native';
import JsSIP from 'jssip';
import { mediaDevices, MediaStream, MediaStreamTrack, RTCRtpReceiver } from 'react-native-webrtc';
import { CONFIG, getPushGateway, getSipWss } from '../config';
import { getMediaConfiguration, MediaConfiguration } from '../network';
import { isTerminalEnrollmentError } from '../gateway/errors';
import { buildGatewaySipWebSocketUrl, gatewayMediaConfiguration, getOrLoadGatewaySession } from '../gateway/session';
import type { GatewaySession } from '../gateway/types';
import { startCallManagers, stopCallManagers, setMicrophoneMute } from '../calls/incall';
import { dismissNativeCallNotification } from '../calls/nativeCallNotification';
import { CodecPreference } from '../storage/store';
import { resolveCallerName } from '../calls/callerNameResolver';
import { callDisplayName } from '../calls/callerName';
import { getDeviceUuid } from '../storage/deviceId';
import { getSecureRandomHex } from '../gateway/secureRandom';
import { appendQuery } from '../gateway/urls';
import { HandoverSocket } from './HandoverSocket';

const CALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bounded ICE gathering for relay-required (gateway/TURN) sessions.
 *
 * Chrome/Safari can keep `iceGatheringState` at "gathering" for ~40 s when one
 * local interface cannot reach the TURN server (VPN, tailnet, docker bridge),
 * even though every usable relay candidate is in the local SDP within ~1 s.
 * JsSIP 3.13 exposes `{ candidate, ready }` on its `icecandidate` event, so we
 * wait for the first *relay* candidate plus a short grace and then release the
 * local SDP exactly once. Gathering never completes → the call is aborted
 * instead of signalling an SDP without a relay candidate.
 */
export const ICE_RELAY_GRACE_MS = 300;
export const ICE_RELAY_CAP_MS = 3000;
/**
 * Cellular networks can take several seconds to produce a TURN allocation and
 * relay candidate. The pre-relay budget is deliberately generous (10–15 s);
 * once a relay candidate is actually in the local SDP the grace above keeps
 * call setup fast.
 */
export const ICE_RELAY_WAIT_MS = 12000;

type IceGatheringConnection = {
  localDescription?: { sdp?: string } | null;
  iceGatheringState?: string;
  addEventListener?: (event: string, fn: () => void) => void;
  removeEventListener?: (event: string, fn: () => void) => void;
};

type IceGatheringSession = {
  on: (event: string, fn: (arg?: unknown) => void) => void;
  terminate?: (options?: unknown) => void;
  /** RTCPeerConnection (JsSIP `connection` getter); shape varies by version. */
  connection?: unknown;
};

type RecoverableSession = IceGatheringSession & {
  isEstablished?: () => boolean;
  isReadyToReOffer?: () => boolean;
  renegotiate?: (options: { rtcOfferConstraints: { iceRestart: boolean } }, done: () => void) => boolean;
  connection?: { setConfiguration?: (configuration: MediaConfiguration) => void };
};

try {
  JsSIP.debug.disable();
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
  isGsmInterrupted?: boolean;
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

export interface CallEndDetails {
  originator?: string;
  statusCode?: number;
  reasonPhrase?: string;
}

export interface AttendedTransferState {
  originalCallId: string;
  originalTarget: string;
  consultCallId?: string;
  consultTarget: string;
  status: 'holding' | 'dialing' | 'ringing' | 'connected' | 'swapping' | 'transferring' | 'recovering';
  activeLine: 'original' | 'consult';
  error?: string;
}

export interface SipEvents {
  onStateChange: (state: SipState) => void;
  onIncomingCall: (info: IncomingCallInfo) => void;
  onCallEstablished: (call: ActiveCall) => void;
  onCallStatusChange?: (call: ActiveCall) => void;
  onCallEnded: (callId: string, cause?: string, details?: CallEndDetails) => void;
  onCallHoldChange?: (isHeld: boolean) => void;
  onCallMuteChange?: (isMuted: boolean) => void;
  onRegistrationFailed?: (code: number, cause?: string) => void;
  onAttendedTransferChange?: (state: AttendedTransferState | null) => void;
  onTransferError?: (message: string) => void;
}
export class JsSipService {
  private ua: JsSIP.UA | null = null;
  private currentSession: unknown = null;
  // Attended transfer: second consultation session slot
  private consultSession: unknown = null;
  private primaryCall: ActiveCall | null = null;
  private consultCall: ActiveCall | null = null;
  private attendedTransfer: AttendedTransferState | null = null;
  /** True when user manually held the primary line (not GSM-driven). */
  private primaryManualHold = false;
  private preferredCodec: CodecPreference = 'pcmu';
  private micVolume = 50;
  private speakerVolume = 85;
  private micGainDb = 0;
  private liveGainTimer: number | null = null;
  private liveGainResolve: ((value: boolean) => void) | null = null;
  private pendingGainDb: number | null = null;
  // Tracks the gain actually applied on the PBX channel so returning to 0 dB
  // resets VOLUME(RX) instead of leaving the last boost active.
  private appliedMicGainDb = 0;
  private appliedMicGainCallId: string | null = null;

  setPreferredCodec(codec: CodecPreference): void {
    this.preferredCodec = codec;
    console.log(`[sip] preferred audio codec set to: ${codec}`);
  }

  setMicVolume(percent: number): void {
    this.micVolume = Math.max(0, Math.min(100, percent));
    // Map 0..100% to -12 dB .. +6 dB with 50% = 0 dB (calibrated unity gain)
    const db = Math.round(((this.micVolume - 50) / 50) * (this.micVolume >= 50 ? 6 : 12));
    this.micGainDb = db;
    if (this.activeCall) {
      void this.setLiveMicGain(db, this.activeCall.id);
    }
  }

  setMicGainDb(gainDb: number): void {
    this.micGainDb = Math.max(-12, Math.min(6, gainDb));
    // Map back to 0..100% for slider display
    if (this.micGainDb >= 0) {
      this.micVolume = Math.round(50 + (this.micGainDb / 6) * 50);
    } else {
      this.micVolume = Math.round(50 + (this.micGainDb / 12) * 50);
    }
    if (this.activeCall) {
      void this.setLiveMicGain(this.micGainDb, this.activeCall.id);
    }
  }

  getMicGainDb(): number {
    return this.micGainDb;
  }

  getSpeakerVolumePercent(): number {
    return this.speakerVolume;
  }

  async setLiveMicGain(gainDb: number, callId?: string): Promise<boolean> {
    const targetCallId = callId || this.activeCall?.id;
    this.micGainDb = Math.max(-12, Math.min(6, gainDb));
    if (!targetCallId) {
      return false;
    }

    this.pendingGainDb = this.micGainDb;
    clearTimeout(this.liveGainTimer ?? undefined);
    this.liveGainResolve?.(false);
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    this.liveGainResolve = resolve;
    this.liveGainTimer = setTimeout(async () => {
        const gain = this.pendingGainDb ?? this.micGainDb;
        this.liveGainTimer = null;
        this.liveGainResolve = null;
        if (this.appliedMicGainCallId === targetCallId && this.appliedMicGainDb === gain) {
          resolve(true);
          return;
        }
        try {
          const gateway = getPushGateway(this.serverHost) || CONFIG.pushGateway;
          const res = await fetch(`${gateway}/api/call/volume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              extension: this.extension,
              callId: targetCallId,
              micGainDb: gain,
              gainDb: gain,
            }),
          });
          const json = (await res.json()) as { success?: boolean };
          if (json.success) {
            this.appliedMicGainDb = gain;
            this.appliedMicGainCallId = targetCallId;
          }
          console.log(`[sip] live mic gain ${gain}dB dispatched for callId=${targetCallId}: success=${json.success}`);
          resolve(!!json.success);
        } catch (err) {
          console.warn('[sip] failed to dispatch live mic gain to gateway:', err);
          resolve(false);
        }
      }, 150) as unknown as number;
    return promise;
  }

  setSpeakerVolume(percent: number): void {
    this.speakerVolume = Math.max(0, Math.min(100, percent));
    const gain = this.speakerVolume / 100.0;
    if (this.activeCall?.remoteStream) {
      try {
        const tracks = this.activeCall.remoteStream.getAudioTracks ? this.activeCall.remoteStream.getAudioTracks() : [];
        tracks.forEach((t: unknown) => {
          this.applyTrackVolume(t, gain);
        });
      } catch (err) {
        console.warn('[sip] failed to set speaker volume on track:', err);
      }
    }

    try {
      const session = this.currentSession;
      if (session && typeof session === 'object' && 'connection' in session) {
        const conn = (session as { connection?: unknown }).connection;
        if (conn && typeof conn === 'object' && 'getReceivers' in conn && typeof conn.getReceivers === 'function') {
          const receivers = conn.getReceivers() as Array<{ track?: MediaStreamTrack }>;
          for (const r of receivers) {
            if (r.track && r.track.kind === 'audio') {
              this.applyTrackVolume(r.track, gain);
            }
          }
        }
      }
    } catch {}
  }
  private applyTrackVolume(track: unknown, gain: number): void {
    if (track && typeof track === 'object') {
      if ('_setVolume' in track && typeof track._setVolume === 'function') {
        track._setVolume(gain);
      } else if ('setVolume' in track && typeof track.setVolume === 'function') {
        track.setVolume(gain);
      }
    }
  }

  private events: SipEvents;

  setEvents(events: SipEvents): void {
    this.events = events;
    this.events.onStateChange(this.state);
  }
  private localStream: MediaStream | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private keepAliveTimer: number | null = null;
  private lastNetworkState: { isConnected: boolean; networkType: string } | null = null;
  private extension = '';
  private password = '';
  private serverHost = '';
  private networkDebounceTimer: number | null = null;
  private signalingSocket: HandoverSocket | null = null;
  private mediaRecovery = new Map<RecoverableSession, number>();
  private mediaRecoveryRun: object | null = null;
  private mediaRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private handoverGeneration = 0;
  private useTls = false;
  /** True when the active media configuration is TURN/relay-only. */
  private mediaRelayRequired = false;
  /** Approved gateway assignment backing the current registration, if any. */
  private gatewaySession: GatewaySession | null = null;
  /** Active bounded-ICE-gathering controllers (cancelled on teardown). */
  private iceGatheringControllers = new Set<{ cancel: () => void }>();
  /** One gathering controller per RTCSession (re-armed when media mode is known). */
  private iceGatheringSessions = new WeakMap<object, { cancel: () => void }>();
  /** Call ids aborted because no relay candidate arrived in time. */
  private iceGatheringFailures = new Map<string, string>();
  /** Bumped on every disconnect so a superseded async connect() aborts. */
  private connectionGeneration = 0;

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
   * Signalling endpoint comes from `getSipWss()`: plain `ws://<host>:8088/ws`
   * by default (no certificate warnings) and `wss://<host>:8089/ws` when TLS
   * is enabled. Devices enrolled with the gateway instead use the approved
   * assignment URL plus a freshly minted one-use `?ticket=` for every connect.
   * The UA reuses the persistent install UUID as `instance_id`.
   */
  async connect(extension: string, password: string, host?: string, useTls = false, force = false): Promise<void> {
    const targetHost = host || CONFIG.sipDomain;
    if (
      !force &&
      this.isConnectedOrConnecting() &&
      this.extension === extension &&
      this.password === password &&
      this.serverHost === targetHost &&
      this.useTls === useTls
    ) {
      return;
    }
    this.disconnect(false);
    this.extension = extension;
    this.password = password;
    this.serverHost = targetHost;
    this.useTls = useTls;
    this.setState('connecting');
    this.reconnectAttempt = 0;
    const domain = this.serverHost;
    if (!domain) {
      console.warn('[sip] connect called without a server host');
      this.setState('failed');
      return;
    }
    const generation = this.connectionGeneration;
    // Persistent per-install UUID shared with push registration, so the PBX can
    // correlate a push-woken device with the same SIP contact (GRUU).
    const instanceId = await getDeviceUuid().catch((err) => {
      console.warn('[sip] device uuid unavailable:', err);
      return '';
    });
    if (generation !== this.connectionGeneration) {
      console.log('[sip] connect superseded by a newer disconnect/connect; aborting stale registration');
      return;
    }

    let wsUrl: string;
    let gatewaySession: GatewaySession | null = null;
    try {
      // Enrolled devices must never fall back to the direct PBX socket: a
      // pending/revoked assignment resolves to an error, not to `getSipWss`.
      gatewaySession = await getOrLoadGatewaySession(domain, extension);
      wsUrl = gatewaySession
        ? await buildGatewaySipWebSocketUrl(gatewaySession, getSipWss(domain, this.useTls))
        : getSipWss(domain, this.useTls);
    } catch (err) {
      if (generation !== this.connectionGeneration) return;
      console.error('[sip] gateway signalling rejected:', err);
      this.gatewaySession = null;
      this.setState('failed');
      if (!isTerminalEnrollmentError(err)) {
        this.scheduleReconnect();
      }
      return;
    }
    if (generation !== this.connectionGeneration) {
      console.log('[sip] connect superseded while minting the SIP ticket; aborting');
      return;
    }
    this.gatewaySession = gatewaySession;

    // A flow belongs to this UA, not the account/install. Reusing an install id
    // here could attach a new login to a stale SIP dialog on the gateway.
    let flow: string | null = null;
    try {
      if (gatewaySession) flow = await getSecureRandomHex(16);
    } catch {
      if (generation === this.connectionGeneration) this.setState('failed');
      return;
    }
    if (generation !== this.connectionGeneration) return;
    const withFlow = (url: string) => flow ? appendQuery(url, { flow }) : url;

    console.log(`[sip] connecting via JsSIP to ${wsUrl.replace(/([?&]ticket=)[^&]+/g, '$1[redacted]')} as sip:${extension}@${domain}`);

    try {
      const socket = new HandoverSocket(withFlow(wsUrl), async () => {
        if (generation !== this.connectionGeneration) throw new Error('Superseded SIP connection');
        const url = gatewaySession
          ? await buildGatewaySipWebSocketUrl(gatewaySession, getSipWss(domain, useTls))
          : getSipWss(domain, useTls);
        if (generation !== this.connectionGeneration) throw new Error('Superseded SIP connection');
        return withFlow(url);
      });
      this.signalingSocket = socket;
      const configuration = {
        sockets: [socket],
        uri: `sip:${extension}@${domain}`,
        password,
        authorization_user: extension,
        ...(instanceId ? { instance_id: instanceId } : {}),
        register: true,
        register_expires: 120,
        session_timers: false,
        // HandoverSocket mints a fresh ticket on every transport reconnect,
        // retaining the same UA and confirmed SIP dialogs during short outages.
        connection_recovery_min_interval: 1,
        connection_recovery_max_interval: 3,
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
    // Every handler ignores events from a UA that is no longer the active one.
    // Without this guard a stopped UA's late "unregistered"/"disconnected"
    // event flips the state of the freshly registered UA to offline.
    ua.on('connecting', () => {
      if (this.ua !== ua) return;
      console.log('[sip] connecting WebSocket...');
      if (this.state !== 'registered') {
        this.setState('connecting');
      }
    });

    ua.on('connected', () => {
      if (this.ua !== ua) return;
      console.log('[sip] WebSocket connected, waiting for SIP registration...');
      this.reconnectAttempt = 0;
      if (this.state !== 'registered') {
        this.setState('connecting');
      }
    });

    ua.on('registered', () => {
      if (this.ua !== ua) return;
      console.log('[sip] UA registered successfully with Asterisk');
      this.reconnectAttempt = 0;
      this.setState('registered');
      void this.recoverCallMedia();
    });

    ua.on('unregistered', () => {
      if (this.ua !== ua) return;
      console.log('[sip] UA unregistered');
      if (this.state === 'registered') {
        this.setState('disconnected');
      }
      this.scheduleReconnect();
    });

    ua.on('registrationFailed', (data: { response?: { status_code?: number }; cause?: string }) => {
      if (this.ua !== ua) return;
      const code = data?.response?.status_code || 0;
      console.warn(`[sip] registration failed (code: ${code}, cause: ${data?.cause})`);
      this.events.onRegistrationFailed?.(code, data?.cause);
      if (code === 403) {
        this.setState('failed');
      } else {
        if (this.state !== 'registered') {
          this.setState('disconnected');
        }
        this.scheduleReconnect();
      }
    });

    ua.on('disconnected', () => {
      if (this.ua !== ua) return;
      console.log('[sip] WebSocket disconnected');
      this.queueCallMediaRecovery();
      if (this.state === 'registered' || this.state === 'connecting') {
        this.setState('disconnected');
      }
      this.scheduleReconnect();
    });
    ua.on('newRTCSession', (data: { session: unknown; originator: string; request?: unknown }) => {
      if (this.ua !== ua) return;
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
      refer?: (target: string, opts?: unknown) => void;
      _localHold?: boolean;
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
    // If incoming call has an X-Sokrat-Call-ID UUID, use it (from push-wake correlation).
    // Otherwise fallback gracefully to session.id or timestamp so any standard extension (e.g. 102) can call!
    const callId = (incomingCallId && CALL_ID_PATTERN.test(incomingCallId))
      ? incomingCallId
      : (session.id || String(Date.now()));

    const remoteId = session.remote_identity;
    const target = remoteId?.uri?.user || 'Unknown';
    const targetName = callDisplayName(target);

    // ------------------------------------------------------------------
    // Consultation session routing: if we are waiting for a consult dial
    // and this is a new outgoing session, route it to the consult slot.
    // ------------------------------------------------------------------
    const isConsultSession =
      this.attendedTransfer !== null &&
      this.attendedTransfer.status === 'dialing' &&
      session.direction === 'outgoing';

    if (isConsultSession && this.attendedTransfer) {
      this.consultSession = session;
      const consultCall: ActiveCall = {
        id: callId,
        target,
        targetName,
        direction: 'outbound',
        status: 'calling',
        isMuted: false,
        isHeld: false,
        session,
        remoteStream: null,
      };
      this.consultCall = consultCall;
      // Keep activeCall pointing at consult so controls work for selected line
      this.activeCall = consultCall;
      this.attendedTransfer = {
        ...this.attendedTransfer,
        consultCallId: callId,
        status: 'ringing',
        activeLine: 'consult',
      };
      this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });
      this.attachConsultListeners(session, consultCall);
      return;
    }

    // ------------------------------------------------------------------
    // Normal (primary) session path
    // ------------------------------------------------------------------
    this.currentSession = session;
    this.answerDispatchedSession = null;

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

    if (session.direction === 'outgoing') {
      startCallManagers();
      // Publish the call immediately; contact/network lookup never delays dialing.
      call.targetName = callDisplayName(target);
      this.events.onCallStatusChange?.(call);
      void resolveCallerName(target, {
        extension: this.extension, password: this.password, serverHost: this.serverHost,
        useTls: this.useTls, dnd: false, autoAnswer: false,
      }).then(name => {
        if (this.currentSession !== session || this.activeCall !== call) return;
        call.targetName = callDisplayName(target, name);
        this.events.onCallStatusChange?.(call);
      });
    }

    // Relay sessions use bounded ICE gathering: first relay candidate + short
    // grace, with a hard cap (a relay-less SDP is never sent). Direct-PBX
    // sessions keep JsSIP's default gathering.
    this.attachIceGathering(session, call.id);
    this.watchCallHandover(session);

    // Attach peerconnection remote audio track listeners and codec preferences
    session.on('peerconnection', (data: unknown) => {
      const pc = (data as { peerconnection?: unknown })?.peerconnection as {
        addEventListener?: (event: string, fn: (evt: unknown) => void) => void;
        getTransceivers?: () => Array<{
          receiver?: { track?: MediaStreamTrack };
          sender?: { track?: MediaStreamTrack };
          setCodecPreferences?: (codecs: unknown[]) => void;
        }>;
      } | undefined;

      if (pc) {
        try {
          if (typeof pc.getTransceivers === 'function' && typeof RTCRtpReceiver?.getCapabilities === 'function') {
            const audioCaps = RTCRtpReceiver.getCapabilities('audio');
            if (audioCaps?.codecs) {
              const preferred = this.preferredCodec === 'auto' ? 'opus' : this.preferredCodec.toLowerCase();
              const sorted = [...audioCaps.codecs].sort((a: { mimeType?: string }, b: { mimeType?: string }) => {
                const aName = (a.mimeType || '').toLowerCase();
                const bName = (b.mimeType || '').toLowerCase();
                if (aName.includes(preferred)) return -1;
                if (bName.includes(preferred)) return 1;
                return 0;
              });
              for (const transceiver of pc.getTransceivers()) {
                if (transceiver.receiver?.track?.kind === 'audio' || transceiver.sender?.track?.kind === 'audio') {
                  transceiver.setCodecPreferences?.(sorted);
                }
              }
              console.log(`[sip] prioritized ${preferred} codec via transceiver preferences`);
            }
          }
        } catch (e) {
          console.warn('[sip] transceiver codec preferences notice:', e);
        }

        if (typeof pc.addEventListener === 'function') {
          pc.addEventListener('track', (eventObj: unknown) => {
            const event = eventObj as { track?: MediaStreamTrack; streams?: MediaStream[] };
            console.log('[sip] remote audio track received:', event?.track);
            if (event?.track) {
              event.track.enabled = true;
            }
            if (this.activeCall) {
              const stream =
                event?.streams && event.streams[0]
                  ? event.streams[0]
                  : event?.track
                  ? new MediaStream([event.track])
                  : null;
              if (stream) {
                this.activeCall.remoteStream = stream;
                this.setSpeakerVolume(this.speakerVolume);
              }
            }
          });
          pc.addEventListener('addstream', (eventObj: unknown) => {
            const event = eventObj as { stream?: MediaStream };
            console.log('[sip] remote stream added:', event?.stream);
            if (event?.stream && this.activeCall) {
              this.activeCall.remoteStream = event.stream;
              this.setSpeakerVolume(this.speakerVolume);
            }
          });
        }
      }
    });

    // Ensure local SDP prioritizes preferred codec and enables inband FEC
    session.on('sdp', (dataObj: unknown) => {
      const data = dataObj as { originator?: string; type?: string; sdp?: string } | undefined;
      if (data?.originator === 'local' && data.sdp) {
        data.sdp = this.prioritizeCodecInSdp(data.sdp, this.preferredCodec);
      }
    });

    // Attach session-level listeners
    // Keep diagnostics independent of JsSIP's verbose debug mode: that mode
    // includes authentication headers and full SDP. Only record lifecycle fields.
    const logTermination = (event: 'ended' | 'failed', payload: unknown) => {
      const data = payload as {
        originator?: string;
        cause?: string;
        message?: { status_code?: number; method?: string };
      } | null;
      const connection = session.connection as {
        iceGatheringState?: string;
        iceConnectionState?: string;
        connectionState?: string;
      } | undefined;
      console.warn(`[sip][callId=${call.id}] session ${event} ${JSON.stringify({
        originator: data?.originator,
        cause: data?.cause,
        statusCode: data?.message?.status_code,
        method: data?.message?.method,
        answerDispatched: this.answerDispatchedSession === session,
        currentSession: this.currentSession === session,
        callStatus: call.status,
        iceGatheringState: connection?.iceGatheringState,
        iceConnectionState: connection?.iceConnectionState,
        connectionState: connection?.connectionState,
      })}`);
    };
    for (const event of [
      'getusermediafailed',
      'peerconnection:createofferfailed',
      'peerconnection:createanswerfailed',
      'peerconnection:setlocaldescriptionfailed',
      'peerconnection:setremotedescriptionfailed',
    ]) {
      session.on(event, (error: unknown) => {
        const name = (error as { name?: string } | null)?.name;
        // Error messages can contain entire SDP descriptions; never dump them.
        console.warn(`[sip][callId=${call.id}] media operation failed ${JSON.stringify({ event, name })}`);
      });
    }
    session.on('progress', () => {
      if (this.activeCall?.id === call.id) {
        this.activeCall.status = 'ringing';
        this.events.onCallStatusChange?.(this.activeCall);
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
        this.events.onCallStatusChange?.(this.activeCall);
        void this.setLiveMicGain(this.micGainDb, this.activeCall.id);
        this.setSpeakerVolume(this.speakerVolume);
      }
      this.attachEarlyMediaAudio(session);
    });

    session.on('ended', (evt: unknown) => {
      logTermination('ended', evt);
      if (this.currentSession !== session) return;
      if (this.answerDispatchedSession === session) this.answerDispatchedSession = null;
      const cause = (evt as { cause?: string })?.cause || 'NORMAL_CLEARING';
      if (this.attendedTransfer) {
        // Primary session ended during consultation (e.g. remote hung up)
        this._cleanupAttendedTransfer(false);
        stopCallManagers();
        this.releaseLocalStream();
        this.mediaRelayRequired = false;
        const endedId = call.id;
        this.currentSession = null;
        this.activeCall = null;
        this.events.onCallEnded(endedId, cause);
        return;
      }
      stopCallManagers();
      const endedCallId = call.id;
      dismissNativeCallNotification(endedCallId);
      this.releaseLocalStream();
      this.activeCall = null;
      this.currentSession = null;
      this.mediaRelayRequired = false;
      this.events.onCallEnded(endedCallId, cause);
    });
    session.on('failed', (evt: unknown) => {
      logTermination('failed', evt);
      if (this.currentSession !== session) return;
      if (this.answerDispatchedSession === session) this.answerDispatchedSession = null;
      const e = evt as {
        cause?: string;
        originator?: string;
        message?: { status_code?: number; reason_phrase?: string };
      };
      const iceFailure = this.iceGatheringFailures.get(call.id);
      if (iceFailure) this.iceGatheringFailures.delete(call.id);
      const cause = iceFailure || e?.cause || 'REJECTED';
      const statusCode = iceFailure ? 408 : e?.message?.status_code;
      const reasonPhrase = iceFailure ? 'ICE gathering timeout' : e?.message?.reason_phrase;
      if (this.attendedTransfer) {
        this._cleanupAttendedTransfer(false);
        stopCallManagers();
        this.releaseLocalStream();
        this.mediaRelayRequired = false;
        const failedId = call.id;
        this.currentSession = null;
        this.activeCall = null;
        this.events.onCallEnded(failedId, cause, { originator: e?.originator, statusCode, reasonPhrase });
        return;
      }
      stopCallManagers();
      const failedCallId = call.id;
      dismissNativeCallNotification(failedCallId);
      this.releaseLocalStream();
      this.activeCall = null;
      this.currentSession = null;
      this.mediaRelayRequired = false;
      this.events.onCallEnded(failedCallId, cause, {
        originator: e?.originator,
        statusCode,
        reasonPhrase,
      });
    });

    session.on('hold', () => {
      if (this.activeCall?.id === call.id) {
        this.activeCall.isHeld = true;
        this.events.onCallHoldChange?.(true);
      }
    });

    session.on('unhold', () => {
      if (this.activeCall?.id === call.id) {
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
      // Ring immediately. The app enriches the name without blocking Answer.
      this.events.onIncomingCall(info);
    }
  }

  // -----------------------------------------------------------------------
  // Consultation session listeners (second line in attended transfer)
  // -----------------------------------------------------------------------
  private attachConsultListeners(
    session: {
      on: (event: string, fn: (arg?: unknown) => void) => void;
      connection?: { getReceivers?: () => Array<{ track?: MediaStreamTrack }> };
    },
    consultCall: ActiveCall,
  ) {
    // Consult leg: same full-gathering rule as the primary session.
    this.attachIceGathering(session, consultCall.id);
    this.watchCallHandover(session);

    session.on('peerconnection', (data: unknown) => {
      const pc = (data as { peerconnection?: unknown })?.peerconnection as {
        addEventListener?: (event: string, fn: (evt: unknown) => void) => void;
        getTransceivers?: () => Array<{
          receiver?: { track?: MediaStreamTrack };
          sender?: { track?: MediaStreamTrack };
          setCodecPreferences?: (codecs: unknown[]) => void;
        }>;
      } | undefined;
      if (!pc) return;
      if (typeof pc.addEventListener === 'function') {
        pc.addEventListener('track', (eventObj: unknown) => {
          const event = eventObj as { track?: MediaStreamTrack; streams?: MediaStream[] };
          if (event?.track) event.track.enabled = true;
          if (this.consultCall?.id === consultCall.id) {
            const stream = event?.streams?.[0]
              ?? (event?.track ? new MediaStream([event.track]) : null);
            if (stream) {
              this.consultCall.remoteStream = stream;
              // If consult is active line update speaker
              if (this.attendedTransfer?.activeLine === 'consult') {
                this.setSpeakerVolume(this.speakerVolume);
              }
            }
          }
        });
        pc.addEventListener('addstream', (eventObj: unknown) => {
          const event = eventObj as { stream?: MediaStream };
          if (event?.stream && this.consultCall?.id === consultCall.id) {
            this.consultCall.remoteStream = event.stream;
          }
        });
      }
    });

    session.on('sdp', (dataObj: unknown) => {
      const data = dataObj as { originator?: string; sdp?: string } | undefined;
      if (data?.originator === 'local' && data.sdp) {
        data.sdp = this.prioritizeCodecInSdp(data.sdp, this.preferredCodec);
      }
    });

    session.on('progress', () => {
      if (this.consultCall?.id !== consultCall.id) return;
      this.consultCall.status = 'ringing';
      if (this.attendedTransfer) {
        this.attendedTransfer = { ...this.attendedTransfer, status: 'ringing' };
        this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });
      }
      this.attachEarlyMediaAudio(session);
    });

    session.on('confirmed', () => {
      if (this.consultCall?.id !== consultCall.id) return;
      this.consultCall.status = 'active';
      if (!this.consultCall.startTime) this.consultCall.startTime = Date.now();
      console.log(`[sip][consult callId=${consultCall.id}] consultation session confirmed`);
      if (this.attendedTransfer) {
        this.attendedTransfer = { ...this.attendedTransfer, status: 'connected', activeLine: 'consult' };
        this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });
      }
      // activeCall is consult line; fire statusChange so UI sees 'active'
      if (this.activeCall?.id === consultCall.id) {
        this.activeCall.status = 'active';
        this.events.onCallStatusChange?.(this.activeCall);
      }
      this.attachEarlyMediaAudio(session);
      this.setSpeakerVolume(this.speakerVolume);
    });

    // Consult ended before complete transfer (e.g. colleague rejected/hung up)
    session.on('ended', (evt: unknown) => {
      if (this.consultCall?.id !== consultCall.id) return;
      const cause = (evt as { cause?: string })?.cause || 'NORMAL_CLEARING';
      console.log(`[sip][consult] consultation call ended (${cause}); recovering primary`);
      this._recoverFromFailedConsult('Consultation call ended');
    });
    session.on('failed', (evt: unknown) => {
      if (this.consultCall?.id !== consultCall.id) return;
      const e = evt as { cause?: string; message?: { reason_phrase?: string } };
      const reason = e?.message?.reason_phrase || e?.cause || 'Unavailable';
      console.warn(`[sip][consult] consultation call failed: ${reason}`);
      this._recoverFromFailedConsult(`Consultation failed: ${reason}`);
    });
  }

  // -----------------------------------------------------------------------
  // Recover primary line after consult failure / cancel
  // -----------------------------------------------------------------------
  private _recoverFromFailedConsult(errorMsg?: string) {
    this.consultSession = null;
    this.consultCall = null;
    if (!this.attendedTransfer) return;

    this.attendedTransfer = {
      ...this.attendedTransfer,
      status: 'recovering',
      activeLine: 'original',
      error: errorMsg,
    };
    this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });
    if (errorMsg) this.events.onTransferError?.(errorMsg);

    // Unhold primary session (if we held it when starting consult)
    const primarySess = this.currentSession as { unhold?: () => void } | null;
    if (this.primaryCall) {
      if (this.primaryCall.isHeld && !this.primaryManualHold) {
        primarySess?.unhold?.();
        this.primaryCall.isHeld = false;
      }
      this.primaryCall.status = 'active';
      this.activeCall = this.primaryCall;
      this.events.onCallStatusChange?.(this.activeCall);
    }

    // Clear transfer state
    this.attendedTransfer = null;
    this.primaryCall = null;
    this.primaryManualHold = false;
    this.events.onAttendedTransferChange?.(null);
  }

  // -----------------------------------------------------------------------
  // Full cleanup after complete transfer or primary call ended
  // -----------------------------------------------------------------------
  private _cleanupAttendedTransfer(transferCompleted: boolean) {
    if (!transferCompleted) {
      // Abort: terminate consult if still alive
      const cs = this.consultSession as { terminate?: () => void } | null;
      try { cs?.terminate?.(); } catch {}
    }
    this.consultSession = null;
    this.consultCall = null;
    this.primaryCall = null;
    this.primaryManualHold = false;
    this.attendedTransfer = null;
    this.events.onAttendedTransferChange?.(null);
  }

  // -----------------------------------------------------------------------
  // Public: Attended transfer API
  // -----------------------------------------------------------------------

  /**
   * Hold the primary call and begin a consultation call to targetExtension.
   * Caller must be in an active call (attendedTransfer must be null).
   */
  async startAttendedTransfer(targetExtension: string): Promise<void> {
    if (!this.activeCall || this.activeCall.status !== 'active') {
      throw new Error('No active call to transfer');
    }
    if (this.attendedTransfer) {
      throw new Error('Attended transfer already in progress');
    }

    const primarySess = this.currentSession as {
      hold?: (opts?: unknown, done?: () => void) => boolean | void;
      unhold?: () => void;
    } | null;

    // Snapshot primary before hold so we can restore it
    this.primaryCall = { ...this.activeCall };
    this.primaryManualHold = this.activeCall.isHeld;

    this.attendedTransfer = {
      originalCallId: this.activeCall.id,
      originalTarget: this.activeCall.target,
      consultTarget: targetExtension,
      status: 'holding',
      activeLine: 'original',
    };
    this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });

    // Hold the primary call (sendonly re-INVITE)
    if (!this.activeCall.isHeld) {
      primarySess?.hold?.();
      this.activeCall.isHeld = true;
      if (this.primaryCall) this.primaryCall.isHeld = true;
    }

    // Advance state to dialing before placing the consult call
    this.attendedTransfer = { ...this.attendedTransfer, status: 'dialing' };
    this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });

    // Place consultation call — handleNewRTCSession will route it to consultSession
    await this.call(targetExtension);
  }

  /**
   * Complete the attended transfer: REFER primary session to consult session (RFC 3891).
   * Both calls must be present; consult must be connected.
   */
  completeAttendedTransfer(): void {
    if (!this.attendedTransfer || this.attendedTransfer.status !== 'connected') {
      this.events.onTransferError?.('Cannot complete transfer: consultation call not connected');
      return;
    }
    const primarySess = this.currentSession as {
      refer?: (target: string, opts?: unknown) => void;
      remote_identity?: { uri?: { toString?: () => string; user?: string } };
    } | null;
    const consultSess = this.consultSession as {
      remote_identity?: { uri?: { toString?: () => string } };
      _request?: { call_id?: string };
      _to_tag?: string;
      _from_tag?: string;
    } | null;

    if (!primarySess || !consultSess) {
      this.events.onTransferError?.('Session unavailable');
      return;
    }

    const consultUri = (consultSess as { remote_identity?: { uri?: { toString?: () => string } } })
      ?.remote_identity?.uri?.toString?.() ?? '';
    if (!consultUri) {
      this.events.onTransferError?.('Could not determine consultation URI');
      return;
    }

    this.attendedTransfer = { ...this.attendedTransfer, status: 'transferring' };
    this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });

    primarySess.refer?.(consultUri, {
      replaces: this.consultSession,
      eventHandlers: {
        requestSucceeded: () => {
          console.log('[sip][attended-transfer] REFER 202 accepted; clearing transfer state');
          // Asterisk accepted the REFER. For real-UA targets the primary session
          // will also fire 'ended' shortly — _cleanupAttendedTransfer guards double-call
          // via the attendedTransfer null-check. For IVR/echo endpoints that never tear
          // down the agent leg, this is the only completion signal we get.
          this._cleanupAttendedTransfer(true);
          stopCallManagers();
          const primaryId = this.primaryCall?.id || this.activeCall?.id || '';
          this.currentSession = null;
          this.activeCall = null;
          this.primaryCall = null;
          this.events.onCallEnded(primaryId, 'Transfer completed');
        },
        requestFailed: (data: unknown) => {
          const err = (data as { cause?: string })?.cause || 'REFER failed';
          console.warn('[sip][attended-transfer] REFER failed:', err);
          this.events.onTransferError?.(`Transfer failed: ${err}`);
          // Revert to connected state so user can retry or cancel
          if (this.attendedTransfer) {
            this.attendedTransfer = { ...this.attendedTransfer, status: 'connected', error: err };
            this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });
          }
        },
      },
    });
  }

  /**
   * Cancel the consultation: hang up consult call, unhold primary line.
   */
  cancelAttendedTransfer(): void {
    if (!this.attendedTransfer) return;
    const cs = this.consultSession as { terminate?: () => void } | null;
    try { cs?.terminate?.(); } catch {}
    // _recoverFromFailedConsult handles clearing state and unholding primary
    this._recoverFromFailedConsult();
  }

  /**
   * Swap which line the agent is speaking to.
   * Puts the currently active line on hold and takes the other off hold.
   */
  async swapAttendedLines(): Promise<void> {
    if (!this.attendedTransfer || !this.primaryCall || !this.consultCall) return;
    const { activeLine } = this.attendedTransfer;

    this.attendedTransfer = { ...this.attendedTransfer, status: 'swapping' };
    this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });

    const primarySess = this.currentSession as { hold?: () => void; unhold?: () => void } | null;
    const consultSess = this.consultSession as { hold?: () => void; unhold?: () => void } | null;

    if (activeLine === 'consult') {
      // Hold consult, resume primary
      consultSess?.hold?.();
      if (this.consultCall) {
        this.consultCall.isHeld = true;
      }
      primarySess?.unhold?.();
      if (this.primaryCall) {
        // Preserve isGsmInterrupted flag: if primary was GSM-interrupted before swap it stays
        this.primaryCall.isHeld = false;
        // Don't clear isGsmInterrupted — App.tsx GSM handler owns that
      }
      this.activeCall = this.primaryCall;
      this.attendedTransfer = { ...this.attendedTransfer, status: 'connected', activeLine: 'original' };
    } else {
      // Hold primary, resume consult
      primarySess?.hold?.();
      if (this.primaryCall) {
        // Copy isGsmInterrupted to primaryCall so if it was set App.tsx can still see it via activeCall
        const wasGsmInterrupted = this.activeCall?.isGsmInterrupted;
        this.primaryCall.isHeld = true;
        if (wasGsmInterrupted) this.primaryCall.isGsmInterrupted = true;
      }
      consultSess?.unhold?.();
      if (this.consultCall) {
        this.consultCall.isHeld = false;
      }
      this.activeCall = this.consultCall;
      this.attendedTransfer = { ...this.attendedTransfer, status: 'connected', activeLine: 'consult' };
    }

    this.events.onCallStatusChange?.(this.activeCall!);
    this.events.onAttendedTransferChange?.({ ...this.attendedTransfer });
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
            this.setSpeakerVolume(this.speakerVolume);
          }
        }
      }
    } catch (err) {
      console.warn('[sip] early media audio stream setup warning:', err);
    }
  }

  /**
   * Bounded ICE gathering.
   *
   * Relay-required sessions (gateway/TURN) wait for the first `typ relay`
   * candidate to reach `localDescription`, then a short grace, and finally call
   * JsSIP's own `ready()` exactly once. If no relay candidate arrives within
   * the cap, the session is terminated: a relay-less SDP is never sent.
   *
   * Non-relay (direct PBX) sessions keep JsSIP's default behaviour and only log
   * gathering diagnostics.
   */
  private attachIceGathering(
    session: IceGatheringSession,
    callId: string,
  ) {
    const relayRequired = this.mediaRelayRequired;

    // A session may be re-armed once its actual media mode is known (inbound
    // sessions only learn it inside answer()).
    const sessionKey = session as unknown as object;
    this.iceGatheringSessions.get(sessionKey)?.cancel();

    let cancelled = false;
    /** A gathering cycle is currently being bounded (timer armed). */
    let inCycle = false;
    /** The current cycle already released ready() or aborted. */
    let finished = false;
    let relaySeen = false;
    let candidateSeen = false;
    let readyFn: (() => void) | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let noRelayTimer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    let watchedConnection: IceGatheringConnection | null = null;

    const clearTimers = () => {
      if (graceTimer) clearTimeout(graceTimer);
      if (noRelayTimer) clearTimeout(noRelayTimer);
      if (capTimer) clearTimeout(capTimer);
      graceTimer = null;
      noRelayTimer = null;
      capTimer = null;
    };

    const currentConnection = (): IceGatheringConnection | undefined =>
      session.connection as IceGatheringConnection | undefined;

    const detachConnection = () => {
      const pc = watchedConnection;
      watchedConnection = null;
      if (!pc?.removeEventListener) return;
      try {
        pc.removeEventListener('icegatheringstatechange', onGatheringStateChange);
      } catch {}
    };

    const controller = {
      cancel: () => {
        cancelled = true;
        finished = true;
        inCycle = false;
        clearTimers();
        detachConnection();
        this.iceGatheringControllers.delete(controller);
        if (this.iceGatheringSessions.get(sessionKey) === controller) {
          this.iceGatheringSessions.delete(sessionKey);
        }
      },
    };
    this.iceGatheringControllers.add(controller);
    this.iceGatheringSessions.set(sessionKey, controller);

    const relayInLocalDescription = (): boolean => {
      // Re-read `connection`: inbound sessions create it on answer(), after
      // this listener is attached.
      const sdp = currentConnection()?.localDescription?.sdp;
      return typeof sdp === 'string' && /\btyp relay\b/.test(sdp);
    };

    const finish = (reason: string) => {
      if (cancelled || !inCycle || finished) return;
      finished = true;
      inCycle = false;
      clearTimers();
      if (!readyFn) return;
      console.log(
        `[sip][callId=${callId}] ICE ${reason}; releasing local SDP ` +
        `(relay=${relaySeen}, candidates=${candidateSeen ? 'yes' : 'none'})`,
      );
      try {
        readyFn();
      } catch (err) {
        console.warn(`[sip][callId=${callId}] ice ready() failed:`, err);
      }
    };

    const abort = (reason: string) => {
      if (cancelled || finished) return;
      finished = true;
      inCycle = false;
      clearTimers();
      console.error(
        `[sip][callId=${callId}] ${reason}; aborting instead of sending relay-less SDP`,
      );
      this.iceGatheringFailures.set(callId, 'Audio relay unavailable (ICE timeout)');
      try {
        session.terminate?.({ status_code: 408, reason_phrase: 'ICE gathering timeout' });
      } catch (err) {
        console.warn(`[sip][callId=${callId}] session terminate after ICE timeout failed:`, err);
      }
    };

    const armGrace = () => {
      if (cancelled || finished || !relaySeen || graceTimer) return;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (cancelled || finished) return;
        if (!relayInLocalDescription()) {
          // The browser has not written the relay candidate into the SDP yet;
          // wait for the next candidate, still bounded by the cap timer.
          return;
        }
        finish('relay candidate grace elapsed');
      }, ICE_RELAY_GRACE_MS);
    };

    const armPostRelayCap = () => {
      if (capTimer) clearTimeout(capTimer);
      capTimer = setTimeout(() => {
        capTimer = null;
        if (cancelled || finished) return;
        if (!relaySeen || !relayInLocalDescription()) {
          abort(`no relay candidate in SDP within ${ICE_RELAY_CAP_MS}ms of the first relay`);
          return;
        }
        finish('hard cap reached');
      }, ICE_RELAY_CAP_MS);
    };

    /**
     * Start the no-relay budget. Called only when gathering has genuinely
     * begun: a peer connection merely existing (or microphone permissions
     * being requested) must not consume the cellular call's patience.
     */
    const startCycle = () => {
      if (cancelled || !relayRequired || inCycle) return;
      inCycle = true;
      finished = false;
      relaySeen = false;
      candidateSeen = false;
      readyFn = null;
      clearTimers();
      noRelayTimer = setTimeout(() => {
        noRelayTimer = null;
        if (cancelled || finished) return;
        if (!relaySeen || !relayInLocalDescription()) {
          abort(`no relay candidate within ${ICE_RELAY_WAIT_MS}ms of ICE gathering start`);
          return;
        }
        armPostRelayCap();
        armGrace();
      }, ICE_RELAY_WAIT_MS);
    };

    function onGatheringStateChange() {
      if (cancelled) return;
      const state = watchedConnection?.iceGatheringState
        ?? currentConnection()?.iceGatheringState;
      if (state === 'gathering') {
        // Initial gathering or an ICE restart/hold reINVITE creating a new
        // generation. Re-arm the budget for the new generation.
        startCycle();
        return;
      }
      if (state !== 'complete') return;

      if (!relayRequired) {
        console.log(
          `[sip][callId=${callId}] ICE gathering complete ` +
          `(candidates=${candidateSeen ? 'yes' : 'none'}, relay=${relaySeen})`,
        );
        return;
      }

      if (!inCycle || finished) {
        // Completion of a generation we already released (or cancelled).
        return;
      }
      if (!relaySeen || !relayInLocalDescription()) {
        abort('ICE gathering completed without a relay candidate');
        return;
      }
      finish('gathering complete');
    }

    const watchConnection = (pc?: IceGatheringConnection | null) => {
      if (cancelled) return;
      const connection = pc ?? currentConnection();
      if (!connection) return;
      if (connection === watchedConnection) {
        // The listener is already attached; catch a cycle that started while
        // we were between re-arms.
        if (connection.iceGatheringState === 'gathering') startCycle();
        return;
      }
      detachConnection();
      watchedConnection = connection;
      if (typeof connection.addEventListener !== 'function') return;
      connection.addEventListener('icegatheringstatechange', onGatheringStateChange);
      // Gathering may already be running by the time answer() re-arms us.
      if (connection.iceGatheringState === 'gathering') {
        startCycle();
      } else if (connection.iceGatheringState === 'complete') {
        onGatheringStateChange();
      }
    };

    watchConnection();

    session.on('icecandidate', (data: unknown) => {
      const payload = data as {
        candidate?: { candidate?: string; type?: string } | null;
        ready?: () => void;
      };
      const candidate = payload?.candidate;
      if (!candidate) {
        if (typeof payload?.ready === 'function') readyFn = payload.ready;
        return;
      }

      // First candidate proves gathering is actually running (covers engines
      // whose `icegatheringstatechange` we may have missed). Capture `ready`
      // afterwards because starting a cycle clears the previous generation's.
      if (!inCycle && !finished) startCycle();
      if (!inCycle || finished) return;
      if (typeof payload?.ready === 'function') readyFn = payload.ready;

      candidateSeen = true;
      const line = typeof candidate.candidate === 'string' ? candidate.candidate : '';
      const isRelay = candidate.type === 'relay' || /\btyp relay\b/.test(line);
      if (!isRelay || relaySeen) return;
      relaySeen = true;
      if (!relayRequired) return;
      console.log(`[sip][callId=${callId}] first relay candidate; bounded ICE gathering armed`);
      if (noRelayTimer) {
        clearTimeout(noRelayTimer);
        noRelayTimer = null;
      }
      armPostRelayCap();
      armGrace();
    });

    // Attach as soon as the peer connection exists (inbound sessions create it
    // inside answer()), so the gathering-start event is never missed.
    session.on('peerconnection', (data: unknown) => {
      const pc = (data as { peerconnection?: IceGatheringConnection })?.peerconnection;
      if (pc && typeof pc.addEventListener === 'function') watchConnection(pc);
    });

    session.on('ended', () => controller.cancel());
    session.on('failed', () => controller.cancel());
  }

  /**
   * Stop and drop the local microphone stream. Safe to call repeatedly and
   * from error paths, so failed calls/answers never leave the mic open.
   */
  private releaseLocalStream(): void {
    const stream = this.localStream;
    this.localStream = null;
    if (!stream) return;
    try {
      const tracks = stream.getTracks ? stream.getTracks() : [];
      for (const track of tracks) {
        try {
          track.stop();
        } catch {}
      }
    } catch (err) {
      console.warn('[sip] failed to release local stream:', err);
    }
  }

  /**
   * Fetch the call media configuration and remember whether relay is mandatory
   * for the next session's ICE gathering.
   */
  private async resolveMediaConfiguration(): Promise<MediaConfiguration> {
    const domain = this.serverHost || CONFIG.sipDomain;
    const gatewaySession = this.gatewaySession
      ?? (await getOrLoadGatewaySession(domain, this.extension));
    if (gatewaySession) {
      // Gateway deployments always relay media; no P2P fallback.
      const mediaConfiguration = await gatewayMediaConfiguration(gatewaySession);
      this.mediaRelayRequired = true;
      return mediaConfiguration;
    }
    const mediaConfiguration = await getMediaConfiguration(domain, this.extension, this.password);
    this.mediaRelayRequired = mediaConfiguration.iceTransportPolicy === 'relay';
    return mediaConfiguration;
  }

  /**
   * Acquire local microphone audio stream with echo cancellation and auto gain control.
   */
  private async getLocalAudioStream(): Promise<MediaStream | null> {
    if (Platform.OS === 'android') {
      let hasPermission = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (!hasPermission) {
        // Startup preflight can be missed (e.g. while the phone is on AOD or
        // another window has focus), so always request at the moment audio is
        // actually needed.
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        hasPermission = result === PermissionsAndroid.RESULTS.GRANTED;
      }
      if (!hasPermission) {
        console.warn('[sip] microphone permission is not granted');
        return null;
      }
    }

    let resolve!: (value: MediaStream | null) => void;
    const promise = new Promise<MediaStream | null>((done) => { resolve = done; });
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      console.warn('[sip] microphone acquisition timed out after 6000ms');
      resolve(null);
    }, 6000);
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
        googEchoCancellation: true,
        googAutoGainControl: false,
        googNoiseSuppression: true,
        googHighpassFilter: true,
        googTypingNoiseDetection: false,
        googAudioMirroring: false,
      },
      video: false,
    } as unknown as Parameters<typeof mediaDevices.getUserMedia>[0];

    mediaDevices
      .getUserMedia(constraints)
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
        const finalStream = tracks.length > 0 ? stream : null;
        this.localStream = finalStream;
        resolve(finalStream);
        this.setMicVolume(this.micVolume);
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

    try {
      // Relay credentials are mandatory on public servers: abort the call
      // (and release the microphone) instead of connecting without audio.
      const mediaConfiguration = await this.resolveMediaConfiguration();

      const options: Record<string, unknown> = {
        mediaConstraints: { audio: true, video: false },
        pcConfig: {
          ...mediaConfiguration,
          iceCandidatePoolSize: 0,
        },
        sessionTimersExpires: 120,
      };
      options.mediaStream = localStream;
      this.ua.call(targetUri, options);
    } catch (err) {
      this.mediaRelayRequired = false;
      this.releaseLocalStream();
      console.error('[sip] outbound call dispatch failed:', err);
      throw err;
    }
  }

  /**
   * Answer incoming call session.
   */
  private answerAttempt: { session: unknown; promise: Promise<boolean> } | null = null;
  private answerDispatchedSession: unknown = null;

  answer(callId: string): Promise<boolean> {
    const session = this.currentSession;
    const call = this.activeCall;
    // A delayed native action must never rename/answer an unrelated SIP leg.
    if (!session || !call || call.direction !== 'inbound' ||
        (call.id !== callId && (session as { id?: string }).id !== callId)) {
      return Promise.resolve(false);
    }
    const pending = this.answerAttempt;
    if (pending && pending.session === session) return pending.promise;
    if (this.answerDispatchedSession === session || call.status === 'active') {
      return Promise.resolve(true);
    }
    const promise = this.answerSession(callId);
    const attempt = { session, promise };
    this.answerAttempt = attempt;
    void promise.finally(() => {
      if (this.answerAttempt === attempt) this.answerAttempt = null;
    }).catch(() => {});
    return promise;
  }

  private async answerSession(callId: string): Promise<boolean> {
    const session = this.currentSession as { id?: string; answer?: (opt?: unknown) => void } | null;
    if (!session || typeof session.answer !== 'function') {
      console.warn(`[sip][callId=${callId}] answer failed: no active session`);
      return false;
    }

    const activeCall = this.activeCall;
    if (!activeCall || activeCall.direction !== 'inbound') {
      console.warn(`[sip][callId=${callId}] answer rejected: no active inbound call`);
      return false;
    }

    const stillCurrent = () => this.currentSession === session && this.activeCall === activeCall;
    const localStream = await this.getLocalAudioStream();
    if (!localStream) {
      console.error(`[sip][callId=${callId}] answer blocked: microphone unavailable`);
      return false;
    }
    if (!stillCurrent()) {
      localStream.getTracks().forEach(track => track.stop());
      return false;
    }
    this.localStream = localStream;

    let mediaConfiguration: MediaConfiguration;
    try {
      mediaConfiguration = await this.resolveMediaConfiguration();
    } catch (error) {
      if (!stillCurrent()) return false;
      this.mediaRelayRequired = false;
      this.releaseLocalStream();
      console.error(`[sip][callId=${callId}] answer blocked: media configuration failed:`, error);
      return false;
    }

    if (!stillCurrent()) {
      if (this.localStream === localStream) this.releaseLocalStream();
      return false;
    }

    // Bounded ICE gathering depends on the media mode that `answer()` will
    // actually use; the initial listener (attached at newRTCSession) cannot
    // know it yet, so re-arm right after the peer connection exists.
    const options: Record<string, unknown> = {
      mediaConstraints: { audio: true, video: false },
      mediaStream: localStream,
      pcConfig: {
        ...mediaConfiguration,
        iceCandidatePoolSize: 0,
      },
    };
    // Install before answer(): peerconnection and early ICE events may be
    // emitted synchronously while JsSIP creates the answer.
    this.attachIceGathering(session as unknown as IceGatheringSession, callId);
    try {
      this.answerDispatchedSession = session;
      session.answer(options);
    } catch (error) {
      if (this.answerDispatchedSession === session) this.answerDispatchedSession = null;
      this.mediaRelayRequired = false;
      this.releaseLocalStream();
      console.error(`[sip][callId=${callId}] answer failed:`, error);
      return false;
    }
    if (!stillCurrent()) return false;
    startCallManagers();
    // answer() starts asynchronous SDP/ICE work. Only `confirmed` may publish
    // establishment; otherwise the UI disappears while the caller still rings.
    console.log(`[sip][callId=${callId}] answer dispatched; waiting for SIP confirmation`);
    return true;
  }

  /**
   * Terminate/hangup active call.
   */
  async hangup(callId?: string): Promise<boolean> {
    if (!this.activeCall || (callId && this.activeCall.id !== callId)) return false;
    console.log(`[sip][callId=${this.activeCall.id}] local hangup requested (status=${this.activeCall.status}, answerDispatched=${this.answerDispatchedSession === this.currentSession})`);
    if (this.activeCall?.status === 'ringing' && this.activeCall?.direction === 'inbound') {
      return this.decline(this.activeCall.id);
    }
    const session = this.currentSession as { terminate?: (opts?: unknown) => void } | null;
    if (!session || typeof session.terminate !== 'function') return false;
    try {
      session.terminate();
    } catch (error) {
      console.warn('[sip] hangup dispatch failed:', error);
      return false;
    }
    if (this.currentSession === session && this.attendedTransfer) {
      this._cleanupAttendedTransfer(false);
    }
    if (this.currentSession === session) {
      this.releaseLocalStream();
      this.mediaRelayRequired = false;
      stopCallManagers();
      dismissNativeCallNotification(callId || this.activeCall?.id || '');
      this.currentSession = null;
      this.activeCall = null;
    }
    return true;
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
    const declinedCall = this.activeCall;
    const session = this.currentSession as { terminate?: (opts?: unknown) => void } | null;
    if (!session || typeof session.terminate !== 'function') return false;
    console.log(`[sip][callId=${declinedCall.id}] local decline requested (answerDispatched=${this.answerDispatchedSession === session})`);
    try {
      session.terminate({
        status_code: 603,
        reason_phrase: 'Decline',
      });
      console.log('[sip] decline dispatched');
      dismissNativeCallNotification(declinedCall.id);
    } catch (error) {
      console.warn('[sip] decline failed:', error);
      return false;
    }
    if (this.currentSession === session) {
      this.releaseLocalStream();
      this.mediaRelayRequired = false;
      this.currentSession = null;
      this.activeCall = null;
    }
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

    setMicrophoneMute(nextMuted);
    this.events.onCallMuteChange?.(nextMuted);
    return nextMuted;
  }

  toggleHold(): boolean {
    const nextHeld = !this.activeCall?.isHeld;
    return this.setHold(nextHeld);
  }

  setHold(hold: boolean): boolean {
    const session = this.currentSession as { hold?: () => void; unhold?: () => void } | null;
    if (!this.activeCall) return false;
    if (this.activeCall.isHeld === hold) return hold;

    this.activeCall.isHeld = hold;
    if (session) {
      if (hold) {
        session.hold?.();
      } else {
        session.unhold?.();
      }
    }

    this.events.onCallHoldChange?.(hold);
    return hold;
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
    const session = this.currentSession as {
      refer?: (target: string) => {
        on?: (event: string, callback: (data?: unknown) => void) => void;
      } | undefined;
    } | null;
    if (!session || typeof session.refer !== 'function') {
      this.events.onTransferError?.('No active call to transfer');
      return;
    }
    const domain = this.serverHost || CONFIG.sipDomain;
    const targetUri = `sip:${target}@${domain}`;
    console.log(`[sip][blind-transfer] REFER ${targetUri}`);
    try {
      const subscriber = session.refer(targetUri);
      subscriber?.on?.('requestSucceeded', () => {
        console.log('[sip][blind-transfer] REFER accepted (202)');
      });
      subscriber?.on?.('requestFailed', (data) => {
        const cause = (data as { cause?: string })?.cause || 'REFER rejected';
        console.warn(`[sip][blind-transfer] REFER failed: ${cause}`);
        this.events.onTransferError?.(`Transfer failed: ${cause}`);
      });
      subscriber?.on?.('accepted', () => {
        console.log('[sip][blind-transfer] transfer completed');
      });
      subscriber?.on?.('failed', (data) => {
        const cause = (data as { cause?: string })?.cause || 'transfer failed';
        console.warn(`[sip][blind-transfer] transfer failed: ${cause}`);
        this.events.onTransferError?.(`Transfer failed: ${cause}`);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[sip][blind-transfer] error:', msg);
      this.events.onTransferError?.(`Transfer failed: ${msg}`);
    }
  }

  private scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (!this.extension || !this.password || !this.serverHost) return;
    if (this.activeCall) return;
    if (this.state === 'failed' && this.reconnectAttempt > 5) return;

    this.reconnectAttempt++;
    const backoff = Math.min(20, Math.round(1.5 * Math.pow(1.8, Math.min(5, this.reconnectAttempt - 1))));
    this.reconnectTimer = setTimeout(() => {
      if (this.activeCall) return;
      if (!this.ua || !this.ua.isRegistered()) {
        this.connect(this.extension, this.password, this.serverHost, this.useTls).catch((err) => {
          console.warn('[sip] reconnect attempt failed:', err);
        });
      }
    }, backoff * 1000);
  }

  async reconnectIfDisconnected(): Promise<void> {
    if (!this.extension || !this.password || !this.serverHost) return;
    if (this.activeCall) return;
    const isUp = this.ua != null && this.ua.isConnected() && this.ua.isRegistered();
    if (!isUp) {
      this.reconnectAttempt = 0;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      await this.connect(this.extension, this.password, this.serverHost, this.useTls).catch(() => {});
    }
  }

  handleNetworkChange(network: { isConnected: boolean; networkType: string }): void {
    const previous = this.lastNetworkState;
    const changed = previous !== null &&
      (previous.isConnected !== network.isConnected || previous.networkType !== network.networkType);
    this.lastNetworkState = { isConnected: network.isConnected, networkType: network.networkType };

    console.log(`[sip] network state: connected=${network.isConnected}, type=${network.networkType}${changed ? ' (changed)' : ''}`);

    if (!network.isConnected) {
      clearTimeout(this.networkDebounceTimer ?? undefined);
      this.networkDebounceTimer = null;
      if (!this.activeCall) {
        this.setState('disconnected');
      }
      return;
    }

    // The subscription emits the current snapshot on start-up, and Android may
    // repeat identical events. Neither should tear down a UA that connect()
    // already started.
    if (!changed) return;

    clearTimeout(this.networkDebounceTimer ?? undefined);
    this.networkDebounceTimer = setTimeout(() => {
      this.networkDebounceTimer = null;
      if (this.activeCall) {
        console.log('[sip] network handover: preserving call, refreshing signaling and ICE');
        this.handoverGeneration++;
        this.queueCallMediaRecovery();
        this.signalingSocket?.reconnect();
      } else {
        void this.forceReconnect();
      }
    }, 350) as unknown as number;
  }

  private queueCallMediaRecovery(): void {
    for (const value of [this.currentSession, this.consultSession]) {
      const session = value as RecoverableSession | null;
      if (session && !this.mediaRecovery.has(session)) {
        this.mediaRecovery.set(session, Date.now() + 20000);
      }
    }
  }

  private watchCallHandover(value: unknown): void {
    const session = value as RecoverableSession;
    const generation = this.connectionGeneration;
    session.on('confirmed', () => { void this.recoverCallMedia(); });
    const cleanup = () => {
      this.mediaRecovery.delete(session);
      // A dropped transport must also recover registration after a call ends.
      // Run after the normal termination listener clears activeCall.
      void Promise.resolve().then(() => {
        if (generation === this.connectionGeneration && this.ua && !this.ua.isConnected()) this.scheduleReconnect();
      });
    };
    session.on('ended', cleanup);
    session.on('failed', cleanup);
  }

  private async recoverCallMedia(): Promise<void> {
    if (this.mediaRecoveryRun || !this.mediaRecovery.size) return;
    clearTimeout(this.mediaRecoveryTimer ?? undefined);
    this.mediaRecoveryTimer = null;
    if (!this.ua?.isConnected() || !this.ua.isRegistered() || this.lastNetworkState?.isConnected === false) return;
    const generation = this.connectionGeneration;
    const handover = this.handoverGeneration;
    const run = {};
    this.mediaRecoveryRun = run;
    try {
      for (const [session, deadline] of this.mediaRecovery) {
        if (Date.now() >= deadline) {
          this.mediaRecovery.delete(session);
          console.warn('[sip] network handover media recovery timed out');
          continue;
        }
        // Wait for initial answer or an in-progress hold/re-INVITE. Never send
        // overlapping offers or replace microphone/hold/mute/call identity.
        if (!session.isEstablished?.() || !session.isReadyToReOffer?.()) continue;
        try {
          const configuration = await this.resolveMediaConfiguration();
          if (generation !== this.connectionGeneration || handover !== this.handoverGeneration ||
              !this.mediaRecovery.has(session) || !this.ua?.isConnected() || !this.ua.isRegistered() ||
              Date.now() >= deadline || !session.isReadyToReOffer?.()) return;
          session.connection?.setConfiguration?.(configuration);
          const dispatched = session.renegotiate?.({ rtcOfferConstraints: { iceRestart: true } }, () => {
            console.log('[sip] network handover ICE re-offer acknowledged');
          });
          if (dispatched) {
            this.mediaRecovery.delete(session);
            console.log('[sip] network handover ICE restart dispatched');
          }
        } catch {
          // API connectivity may lag the network callback; retry within budget.
          // Do not log error bodies carrying device/TURN credentials.
          console.warn('[sip] network handover media refresh pending');
        }
      }
    } finally {
      if (this.mediaRecoveryRun === run) {
        this.mediaRecoveryRun = null;
        if (generation === this.connectionGeneration && this.mediaRecovery.size) {
          this.mediaRecoveryTimer = setTimeout(() => { void this.recoverCallMedia(); }, 500);
        }
      }
    }
  }

  async forceReconnect(): Promise<void> {
    const ext = this.extension;
    const pwd = this.password;
    const host = this.serverHost;
    const tls = this.useTls;
    if (!ext || !pwd || !host) return;
    if (this.activeCall) return;

    console.log('[sip] forcing immediate SIP reconnection due to network handover...');
    this.reconnectAttempt = 0;
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;

    this.disconnect(false);
    const generation = this.connectionGeneration;
    this.setState('connecting');

    setTimeout(() => {
      if (generation !== this.connectionGeneration) return;
      void this.connect(ext, pwd, host, tls, true);
    }, 200);
  }


  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.extension || !this.password || !this.ua) return;
      if (this.activeCall) return;

      if (!this.ua.isConnected()) {
        this.scheduleReconnect();
        return;
      }

      if (!this.ua.isRegistered() && this.state !== 'connecting') {
        try {
          this.ua.register();
        } catch {
          this.scheduleReconnect();
        }
      }
    }, 20000);
  }

  private stopKeepAlive() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  disconnect(notifyState = true) {
    this.handoverGeneration++;
    clearTimeout(this.networkDebounceTimer ?? undefined);
    this.networkDebounceTimer = null;
    clearTimeout(this.mediaRecoveryTimer ?? undefined);
    this.mediaRecoveryTimer = null;
    this.mediaRecovery.clear();
    this.mediaRecoveryRun = null;
    this.answerDispatchedSession = null;
    clearTimeout(this.liveGainTimer ?? undefined);
    this.liveGainTimer = null;
    this.liveGainResolve?.(false);
    this.liveGainResolve = null;
    this.pendingGainDb = null;
    this.connectionGeneration += 1;
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
    this.stopKeepAlive();
    for (const controller of this.iceGatheringControllers) {
      controller.cancel();
    }
    this.iceGatheringControllers.clear();
    this.iceGatheringFailures.clear();
    const ua = this.ua;
    // Detach first so the stopping UA's late events are ignored by the
    // listeners' "this.ua !== ua" guard. ua.stop() can emit "unregistered"
    // synchronously, which used to schedule a reconnect after logout.
    this.ua = null;
    if (ua) {
      try {
        ua.stop();
      } catch {}
    }
    this.signalingSocket = null;
    this.currentSession = null;
    this.activeCall = null;
    this.releaseLocalStream();
    this.mediaRelayRequired = false;
    this.gatewaySession = null;
    if (notifyState) {
      this.setState('disconnected');
    }
  }

  isRegistered(): boolean {
    return (this.ua?.isRegistered() && this.state === 'registered') ?? false;
  }

  isConnectedOrConnecting(): boolean {
    if (this.state === 'connecting') return true;
    if (this.state !== 'registered') return false;
    return (this.ua?.isConnected() && this.ua?.isRegistered()) ?? false;
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

    // 3. For Opus: ensure inband FEC, disable DTX (prevents choppiness), set 64kbps CBR
    const opusPayload = Object.entries(payloadToCodec).find(([, name]) => name === 'opus')?.[0];
    if (opusPayload) {
      for (let i = 0; i < updatedLines.length; i++) {
        if (updatedLines[i].startsWith(`a=fmtp:${opusPayload} `)) {
          let fmtp = updatedLines[i];
          if (!fmtp.includes('useinbandfec=')) fmtp += ';useinbandfec=1';
          if (!fmtp.includes('usedtx=')) fmtp += ';usedtx=0';
          else fmtp = fmtp.replace(/usedtx=1/g, 'usedtx=0');
          if (!fmtp.includes('maxaveragebitrate=')) fmtp += ';maxaveragebitrate=64000';
          if (!fmtp.includes('cbr=')) fmtp += ';cbr=1';
          updatedLines[i] = fmtp;
        }
      }
    }
    return updatedLines.join('\r\n');
  }
}

let sharedJsSipInstance: JsSipService | null = null;

export function getSharedJsSipService(events?: SipEvents): JsSipService {
  if (!sharedJsSipInstance) {
    sharedJsSipInstance = new JsSipService(
      events || {
        onStateChange: () => {},
        onIncomingCall: () => {},
        onCallEstablished: () => {},
        onCallEnded: () => {},
      },
    );
  } else if (events) {
    sharedJsSipInstance.setEvents(events);
  }
  return sharedJsSipInstance;
}
