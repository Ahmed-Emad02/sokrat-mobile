/**
 * Sokrat Standalone WebRTC Softphone Signaling Engine (React Native)
 * Ported directly from Sokrat Voice softphone-core.js (JsSIP v3 + react-native-webrtc).
 */
import '../shims';
import { Platform, PermissionsAndroid } from 'react-native';
import JsSIP from 'jssip';
import { mediaDevices, MediaStream, MediaStreamTrack, RTCRtpReceiver } from 'react-native-webrtc';
import { CONFIG, getPushGateway, getSipWss } from '../config';
import { CALL_VOLUME_PATH, extensionHeaders, getMediaConfiguration, MediaConfiguration } from '../network';
import { createAudioStatsSummarizer, describeSdpForLog, getMediaSourceAudioLevel, type SdpLogSummary } from './MediaDiagnostics';
import { delay } from '../gateway/enrollment';
import { isTerminalEnrollmentError } from '../gateway/errors';
import { ensureVpn, getVpnPublicKey, type VpnProfile } from '../vpn/VpnManager';
import {
  buildGatewaySipWebSocketUrl,
  gatewayMediaConfiguration,
  getActiveGatewaySession,
  getCachedGatewaySession,
  getGatewayCallState,
  getGatewayVpnProfile,
  getOrLoadGatewaySession,
} from '../gateway/session';
import type { GatewaySession, GatewayDirectFallback } from '../gateway/types';
import {
  startCallManagers,
  stopCallManagers,
  startOutgoingRingback,
  stopOutgoingRingback,
  stopOutgoingRingbackAfterMedia,
  setMicrophoneMute,
  getAudioDeviceState,
  setPreferredCallInputDevice,
} from '../calls/incall';
import {
  INITIAL_TRUNK_RECONCILE_MEMORY,
  nextTrunkReconcileAction,
  shouldReconcileTrunk,
  TRUNK_STATE_PATH,
} from '../calls/trunkReconcile';
import type { TrunkReconcileMemory } from '../calls/trunkReconcile';
import {
  clampMicGainDb,
  MIC_MAX_PERCENT,
  micDbToPercent,
  micPercentToDb,
  SPEAKER_MAX_PERCENT,
  speakerPercentToGain,
} from '../calls/audioLevels';
import { dismissNativeCallNotification, getMediaDiagnosticsWriter } from '../calls/nativeCallNotification';
import { MIC_AGC_CENTER_DB, nextMicAgcGain } from '../calls/micAgc';
import { CodecPreference } from '../storage/store';
import { resolveCallerName } from '../calls/callerNameResolver';
import { callDisplayName, usableProviderName } from '../calls/callerName';
import { getDeviceUuid } from '../storage/deviceId';
import { getSecureRandomHex } from '../gateway/secureRandom';
import { appendQuery, gatewayAuthHeaders } from '../gateway/urls';
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
export const ICE_RELAY_GRACE_MS = 150;
export const ICE_RELAY_CAP_MS = 1500;
/**
 * Relay-only sessions may need a TURN allocation on cellular, but must never
 * hold a normal call's SDP hostage. Auto/host-capable sessions skip this wait.
 */
export const ICE_RELAY_WAIT_MS = 2000;

/**
 * Call-state safety bounds. A signaling loss that is not repaired inside the
 * grace window ends the call instead of freezing the UI/ringback; an outbound
 * session rings for at most the ring timeout, and a 2xx that never confirms is
 * abandoned after the confirmation timeout.
 */
export const SIGNALING_GRACE_MS = 8000;
export const OUTGOING_RING_TIMEOUT_MS = 60_000;
export const CONFIRMATION_TIMEOUT_MS = 10_000;

/**
 * A WireGuard interface can report UP while its peer is unreachable (for
 * example, the cached profile points at a private LAN address while the phone
 * is on another network). Probe the private SIP WebSocket before committing to
 * the direct path so the normal gateway/TURN fallback can take over.
 */
async function probePrivateSipWebSocket(url: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A plain HTTP probe reaches the same private host/port as the SIP
    // WebSocket. Any HTTP response proves the route exists; only a transport
    // failure/timeout means the direct VPN path is unusable.
    const target = url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    await fetch(target, { method: 'GET', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function hostFromApiUrl(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i.exec(url.trim());
  if (!match) return '';
  return match[2] ? `${match[1]}:${match[2]}` : match[1];
}

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

type EarlyMediaConnection = {
  remoteDescription?: { sdp?: string } | null;
  getReceivers?: () => Array<{ track?: MediaStreamTrack }>;
  getStats?: () => Promise<Map<string, unknown>>;
};

/**
 * How often the early-media readiness check samples native RTP statistics
 * while the call is still ringing (the poll runs until RTP, confirmation, or
 * teardown; carriers can start early media many seconds after the 183).
 */
export const EARLY_MEDIA_POLL_MS = 250;
const MEDIA_RECOVERY_CONFIRM_DELAY_MS = 1200;

function earlyMediaConnection(session: { connection?: unknown }): EarlyMediaConnection | null {
  const raw = session.connection;
  if (!raw || typeof raw !== 'object') return null;
  // The peer connection is a native-backed object; its members are checked at
  // each use (typeof / optional chaining) instead of trusting a full shape.
  return raw as EarlyMediaConnection;
}

function audioReceiverTracks(pc: EarlyMediaConnection): MediaStreamTrack[] {
  if (typeof pc.getReceivers !== 'function') return [];
  const tracks: MediaStreamTrack[] = [];
  for (const receiver of pc.getReceivers()) {
    const track = receiver?.track;
    if (track && track.kind === 'audio' && track.readyState !== 'ended') tracks.push(track);
  }
  return tracks;
}

/** True when an inbound RTP audio report already shows received media. */
function hasInboundAudio(stats: Map<string, unknown> | null | undefined): boolean {
  if (!stats) return false;
  for (const report of stats.values()) {
    if (!report || typeof report !== 'object') continue;
    if (!('type' in report) || report.type !== 'inbound-rtp') continue;
    const kind = 'kind' in report ? report.kind : 'mediaType' in report ? report.mediaType : undefined;
    if (kind !== 'audio') continue;
    const packets = 'packetsReceived' in report ? Number(report.packetsReceived) : 0;
    const bytes = 'bytesReceived' in report ? Number(report.bytesReceived) : 0;
    if (packets > 0 || bytes > 0) return true;
  }
  return false;
}

/**
 * Whether the remote party's audio section actually sends media to us.
 *
 * A provisional answer is only playable early media when its `m=audio` section
 * is enabled (port is not 0) and is `sendrecv`/`sendonly` (the default when no
 * direction attribute is present). `recvonly`, `inactive`, a disabled port, or
 * a missing audio section means there is nothing to hear yet, so the local
 * ringback must keep playing. A session-level direction only counts before the
 * first media section; a direction inside a preceding `m=video`/application
 * section belongs to that section, never to the session.
 */
export function remoteAudioSends(sdp?: string | null): boolean {
  if (!sdp) return false;
  let sessionDirection = '';
  let inAudio = false;
  let audioFound = false;
  let audioDirection = '';
  let inAnySection = false;
  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('m=')) {
      if (inAudio) break;
      inAnySection = true;
      inAudio = line.startsWith('m=audio');
      if (inAudio) {
        // `m=audio 0 ...` is a rejected/disabled media section.
        const port = (line.split(/\s+/)[1] || '').split('/')[0];
        if (port === '0') return false;
        audioFound = true;
      }
      continue;
    }
    if (line !== 'a=sendrecv' && line !== 'a=sendonly' &&
        line !== 'a=recvonly' && line !== 'a=inactive') {
      continue;
    }
    if (inAudio) audioDirection = line.slice(2);
    else if (!inAnySection) sessionDirection = line.slice(2);
  }
  if (!audioFound) return false;
  const direction = audioDirection || sessionDirection || 'sendrecv';
  return direction === 'sendrecv' || direction === 'sendonly';
}

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

type OutboundCallKind = 'primary' | 'consult';

interface LocalAudioCapture {
  stream: MediaStream | null;
  /** True only for newly captured audio that this attempt may stop. */
  ownsStream: boolean;
}

/**
 * One outbound dial reservation. It is taken synchronously before any async
 * microphone/TURN work, so two taps cannot both dispatch an INVITE, and it is
 * validated against the captured UA/generation after every await.
 */
interface OutboundCallAttempt extends LocalAudioCapture {
  kind: OutboundCallKind;
  ua: JsSIP.UA;
  generation: number;
  /** Set synchronously by handleNewRTCSession when it refuses this INVITE. */
  outcome: 'pending' | 'accepted' | 'rejected';
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
  onTrunkLost?: (callId: string) => void;
}
export class JsSipService {
  private ua: JsSIP.UA | null = null;
  private currentSession: unknown = null;
  // Attended transfer: second consultation session slot
  private consultSession: unknown = null;
  /** In-flight outbound dial that owns the next outgoing INVITE. */
  private outboundAttempt: OutboundCallAttempt | null = null;
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
    this.micVolume = Math.max(0, Math.min(MIC_MAX_PERCENT, percent));
    this.micGainDb = micPercentToDb(this.micVolume);
    this.micAgcSuspended = true;
    if (this.activeCall) {
      void this.setLiveMicGain(this.micGainDb, this.activeCall.id);
    }
  }

  setMicGainDb(gainDb: number): void {
    this.micGainDb = clampMicGainDb(gainDb);
    this.micVolume = micDbToPercent(this.micGainDb);
    this.micAgcSuspended = true;
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
    this.micGainDb = clampMicGainDb(gainDb);
    if (!targetCallId) {
      return false;
    }
    // PBX-direct accounts have no gateway call-volume endpoint. Keep the
    // account fully local instead of firing a request that can only fail.
    if (this.directSip) return false;

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
          const gatewaySession = getActiveGatewaySession(this.serverHost, this.extension);
          const gateway = gatewaySession?.apiURL || getPushGateway(this.serverHost) || CONFIG.pushGateway;
          const path = gatewaySession ? '/api/gateway/call/volume' : '/api/call/volume';
          const headers = gatewaySession
            ? {
                ...gatewayAuthHeaders({ claimSecret: gatewaySession.claimSecret, deviceId: gatewaySession.deviceId, json: true }),
                ...extensionHeaders({
                  extension: this.extension,
                  password: this.password,
                  path: CALL_VOLUME_PATH,
                  method: 'POST',
                }),
              }
            : { 'Content-Type': 'application/json' };
          const res = await fetch(`${gateway}${path}`, {
            method: 'POST',
            headers,
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
    this.speakerVolume = Math.max(0, Math.min(SPEAKER_MAX_PERCENT, percent));
    const gain = speakerPercentToGain(this.speakerVolume);
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
  private lastNetworkState: { isConnected: boolean; networkType: string; networkId?: string } | null = null;
  private extension = '';
  private password = '';
  private serverHost = '';
  private networkDebounceTimer: number | null = null;
  private signalingSocket: HandoverSocket | null = null;
  private mediaRecovery = new Map<RecoverableSession, number>();
  private mediaRecoveryConfirmTimers = new Map<RecoverableSession, ReturnType<typeof setTimeout>>();
  private mediaRecoveryRun: object | null = null;
  private mediaRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private handoverGeneration = 0;
  private useTls = false;
  /** True when the account bypasses gateway enrollment and registers directly. */
  private directSip = false;
  /** True when the active media configuration is TURN/relay-only. */
  private mediaRelayRequired = false;
  private pendingRelayRequired: boolean | null = null;
  /** Short-lived prefetched ICE/TURN configuration shared by calls. */
  private mediaConfigurationCache: {
    key: string;
    expiresAt: number;
    promise: Promise<MediaConfiguration>;
  } | null = null;
  /** Set by the account layer before connect(); direct accounts skip gateway enrollment. */
  setDirectSipMode(enabled: boolean): void {
    this.directSip = Boolean(enabled);
  }
  /** Approved gateway assignment backing the current registration, if any. */
  private gatewaySession: GatewaySession | null = null;
  /** Direct-PBX registration over the embedded VPN, when available. */
  private directVpn = false;
  private vpnProfile: VpnProfile | null = null;
  /** Public PBX fallback for this exact assignment, when its PBX opted in. */
  private directFallback: GatewayDirectFallback | null = null;
  private directFallbackHost = '';
  /** Active bounded-ICE-gathering controllers (cancelled on teardown). */
  private iceGatheringControllers = new Set<{ cancel: () => void }>();
  /** One gathering controller per RTCSession (re-armed when media mode is known). */
  private iceGatheringSessions = new WeakMap<object, { cancel: () => void }>();
  /** Call ids aborted because no relay candidate arrived in time. */
  private iceGatheringFailures = new Map<string, string>();
  /** Outbound dongle reconciliation timer; exactly one call at a time. */
  private trunkPollTimer: ReturnType<typeof setTimeout> | null = null;
  private trunkPollCallId: string | null = null;
  private trunkPollMemory: TrunkReconcileMemory = INITIAL_TRUNK_RECONCILE_MEMORY;
  /** Ends a call when a dropped signaling transport is not restored in time. */
  private signalingLossTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bounds how long an outbound session may stay in ringing/calling. */
  private outgoingRingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bounds a 2xx that never reaches `confirmed`. */
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every disconnect so a superseded async connect() aborts. */
  private connectionGeneration = 0;
  private stopMediaDiagnostics: (() => void) | null = null;
  private mediaStatsPending = false;
  private stopMicAgc: (() => void) | null = null;
  private micAgcPending = false;
  private micAgcGainDb = MIC_AGC_CENTER_DB;
  private micAgcSuspended = false;
  /** Early-media RTP readiness poll (see watchEarlyMedia). */
  private earlyMediaTimer: ReturnType<typeof setTimeout> | null = null;
  /** Call id with a live early-media poll, or null. */
  private earlyMediaWatchCall: string | null = null;
  /** One post-registration retry when the VPN handshake missed the probe window. */
  private directRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private directRetryAttempts = 0;

  state: SipState = 'disconnected';
  activeCall: ActiveCall | null = null;

  constructor(events: SipEvents) {
    this.events = events;
  }

  private setState(s: SipState) {
    this.state = s;
    this.events.onStateChange(s);
  }

  private stopTrunkReconcile(): void {
    if (this.trunkPollTimer) {
      clearTimeout(this.trunkPollTimer);
      this.trunkPollTimer = null;
    }
    this.trunkPollCallId = null;
    this.trunkPollMemory = INITIAL_TRUNK_RECONCILE_MEMORY;
  }

  private clearSignalingWatchdog(): void {
    if (this.signalingLossTimer) {
      clearTimeout(this.signalingLossTimer);
      this.signalingLossTimer = null;
    }
  }

  private clearOutgoingTimers(): void {
    if (this.outgoingRingTimer) {
      clearTimeout(this.outgoingRingTimer);
      this.outgoingRingTimer = null;
    }
    if (this.confirmationTimer) {
      clearTimeout(this.confirmationTimer);
      this.confirmationTimer = null;
    }
    // A queued gain update belongs to the call that scheduled it. Without
    // this, the timer can fire after hangup and POST the previous call's
    // target/mic gain into the next call.
    this.clearLiveMicGain();
  }

  private clearLiveMicGain(): void {
    clearTimeout(this.liveGainTimer ?? undefined);
    this.liveGainTimer = null;
    this.liveGainResolve?.(false);
    this.liveGainResolve = null;
    this.pendingGainDb = null;
  }

  /** Bound how long an outbound session may ring without a terminal event. */
  private armOutgoingRingTimeout(callId: string): void {
    this.clearOutgoingTimers();
    this.outgoingRingTimer = setTimeout(() => {
      this.outgoingRingTimer = null;
      if (this.activeCall?.id !== callId || this.currentSession === null) return;
      if (this.activeCall.status === 'active') return;
      console.warn(`[sip][callId=${callId}] outbound ring timeout; ending call`);
      this.endCallLocally(callId, 'NO_ANSWER', {
        statusCode: 408,
        reasonPhrase: 'Ring timeout',
      });
    }, OUTGOING_RING_TIMEOUT_MS);
  }

  /** The callee answered but JsSIP never reached `confirmed`. */
  private armConfirmationTimeout(callId: string): void {
    if (this.confirmationTimer) {
      clearTimeout(this.confirmationTimer);
      this.confirmationTimer = null;
    }
    if (this.outgoingRingTimer) {
      clearTimeout(this.outgoingRingTimer);
      this.outgoingRingTimer = null;
    }
    this.confirmationTimer = setTimeout(() => {
      this.confirmationTimer = null;
      if (this.activeCall?.id !== callId) return;
      console.warn(`[sip][callId=${callId}] call accepted without confirmation; ending call`);
      this.endCallLocally(callId, 'CONFIRMATION_TIMEOUT', {
        reasonPhrase: 'Call setup failed',
      });
    }, CONFIRMATION_TIMEOUT_MS);
  }

  /**
   * A signaling transport that stays down during a call can never deliver a
   * final response: without this the UI and local ringback freeze forever.
   * Give handover a short window, then tear the call down locally.
   */
  private armSignalingWatchdog(): void {
    if (this.signalingLossTimer || !this.activeCall) return;
    const callId = this.activeCall.id;
    console.warn(`[sip][callId=${callId}] signaling lost; ${SIGNALING_GRACE_MS}ms grace`);
    this.signalingLossTimer = setTimeout(() => {
      this.signalingLossTimer = null;
      if (this.ua?.isConnected() && this.ua?.isRegistered()) return;
      if (!this.activeCall || this.activeCall.id !== callId) return;
      console.warn(`[sip][callId=${callId}] signaling not restored; ending call`);
      this.endCallLocally(callId, 'SIGNALING_LOST', { reasonPhrase: 'Signalling lost' });
    }, SIGNALING_GRACE_MS);
    // HandoverSocket opens a fresh ticket URL; a no-op if already connecting.
    try {
      this.signalingSocket?.connect();
    } catch {}
  }

  /**
   * Tear a call down without waiting for JsSIP. State is cleared before the
   * session is terminated so a synchronous `failed`/`ended` from terminate()
   * cannot emit a second onCallEnded.
   */
  private endCallLocally(
    callId: string,
    cause: string,
    details?: { originator?: string; statusCode?: number; reasonPhrase?: string },
  ): void {
    if (!this.activeCall && !this.currentSession) return;
    const session = this.currentSession as { terminate?: (opts?: unknown) => void } | null;
    this.clearSignalingWatchdog();
    this.clearOutgoingTimers();
    stopOutgoingRingback();
    this.stopEarlyMediaWatch();
    this.stopTrunkReconcile();
    this.stopMediaDiagnostics?.();
    this.stopMediaDiagnostics = null;
    this.stopMicAgc?.();
    this.stopMicAgc = null;
    if (this.attendedTransfer) this._cleanupAttendedTransfer(false);
    stopCallManagers();
    this.releaseLocalStream();
    this.answerDispatchedSession = null;
    this.currentSession = null;
    this.activeCall = null;
    this.consultSession = null;
    this.mediaRelayRequired = false;
    dismissNativeCallNotification(callId);
    try {
      session?.terminate?.();
    } catch {}
    this.events.onCallEnded(callId, cause, details);
    // The call no longer blocks registration recovery.
    if (!this.ua?.isConnected()) this.scheduleReconnect();
  }

  /**
   * chan_dongle does not reliably emit a final SIP response when the GSM leg
   * disappears. Poll the authenticated gateway state after dialing an
   * external number; two consecutive "trunk gone" or "caller gone" snapshots
   * end the call. The first active sample arms the caller-gone rule so a PBX
   * that has not observed the call yet cannot cause a false teardown.
   */
  private startTrunkReconcile(call: ActiveCall, target: string): void {
    this.stopTrunkReconcile();
    if (!this.gatewaySession || !shouldReconcileTrunk(call.direction, target)) return;
    const callId = call.id;
    this.trunkPollCallId = callId;
    this.trunkPollMemory = INITIAL_TRUNK_RECONCILE_MEMORY;
    const poll = async (): Promise<void> => {
      if (this.trunkPollCallId !== callId || this.activeCall?.id !== callId) {
        this.stopTrunkReconcile();
        return;
      }
      let state: Awaited<ReturnType<typeof getGatewayCallState>> = null;
      try {
        const extensionAuth = extensionHeaders({
          extension: this.extension,
          password: this.password,
          path: TRUNK_STATE_PATH,
          method: 'GET',
        });
        state = await getGatewayCallState(this.serverHost, this.extension, extensionAuth);
      } catch (error) {
        // Network/PBX-API failures are not evidence that the call ended.
        if (this.trunkPollCallId !== callId) return;
        console.warn('[sip] trunk state poll failed:', error);
      }
      if (this.trunkPollCallId !== callId || this.activeCall?.id !== callId) return;
      const decision = nextTrunkReconcileAction(state, this.trunkPollMemory);
      this.trunkPollMemory = decision.memory;
      if (decision.action === 'end') {
        console.warn(
          `[sip][callId=${callId}] gateway reports ${decision.cause}; ending call`,
        );
        this.stopTrunkReconcile();
        this.events.onTrunkLost?.(callId);
        await this.hangup(callId);
        return;
      }
      if (this.trunkPollCallId === callId && this.activeCall?.id === callId) {
        this.trunkPollTimer = setTimeout(() => { void poll(); }, 2000);
      }
    };
    this.trunkPollTimer = setTimeout(() => { void poll(); }, 3000);
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
    let sipDomain = domain;
    this.directFallback = null;
    this.directFallbackHost = '';
    this.directVpn = false;
    this.vpnProfile = null;
    try {
      if (this.directSip) {
        // Normal SIP-client path: register directly to the PBX over WS/WSS.
        // Never probe or enroll with a gateway in this mode.
        wsUrl = getSipWss(domain, this.useTls);
        console.log(`[sip] direct SIP mode: ${wsUrl}`);
      } else {
        // Reuse the approved assignment when possible; the full claim path is a
        // fallback for first enrolment or a missing/pending record.
        gatewaySession = await getCachedGatewaySession(domain, extension);
        if (!gatewaySession) {
          gatewaySession = await getOrLoadGatewaySession(domain, extension);
        }

        let profile: VpnProfile | null = null;
        if (gatewaySession) {
          const vpnPublicKey = await getVpnPublicKey().catch(() => null);
          const gatewayVpn = await getGatewayVpnProfile(gatewaySession, vpnPublicKey).catch(() => null);
          profile = gatewayVpn ? { ...gatewayVpn, name: 'sokratvpn' } : null;
        }
        let vpnReady = profile ? await ensureVpn(profile).catch(() => false) : false;
        if (vpnReady && profile) {
          // A tunnel interface can report UP before its first WireGuard
          // handshake. Probe with a short startup grace period instead of
          // tearing the tunnel down on the first failed attempt; otherwise the
          // resulting network-state change restarts the VPN and repeats the
          // failure indefinitely.
          let reachable = false;
          for (let attempt = 0; attempt < 5 && generation === this.connectionGeneration; attempt++) {
            reachable = await probePrivateSipWebSocket(profile.privateSipUrl, 1200).catch(() => false);
            if (reachable) break;
            await delay(400);
          }
          if (!reachable) {
            // Keep the tunnel available so a later reconnect can use it as soon
            // as the peer handshake completes. The gateway path does not need
            // the private routes.
            vpnReady = false;
            console.log('[sip] direct VPN not ready; keeping tunnel and falling back to gateway media');
          }
        }
        if (vpnReady && profile) {
          this.directVpn = true;
          this.vpnProfile = profile;
          sipDomain = profile.sipDomain;
          wsUrl = profile.privateSipUrl;
          console.log(`[sip] using embedded VPN direct path ${wsUrl} as sip:${extension}@${sipDomain}`);
        } else {
          try {
            wsUrl = gatewaySession
              ? await buildGatewaySipWebSocketUrl(gatewaySession, getSipWss(domain, this.useTls))
              : getSipWss(domain, this.useTls);
          } catch (ticketError) {
            const fallback = gatewaySession?.assignment.directFallback;
            if (!fallback) throw ticketError;
            this.directFallback = fallback;
            this.directFallbackHost = hostFromApiUrl(fallback.apiURL);
            if (!this.directFallbackHost) throw ticketError;
            wsUrl = fallback.wsURL;
            console.warn('[sip] gateway signalling unavailable; using this PBX direct fallback');
          }
          if (profile) {
            // Keep the profile for a one-shot direct upgrade after registration.
            // directVpn remains false until a later connect actually uses it.
            this.vpnProfile = profile;
          }
        }
      }
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

    console.log(`[sip] connecting via JsSIP to ${wsUrl.replace(/([?&]ticket=)[^&]+/g, '$1[redacted]')} as sip:${extension}@${sipDomain}`);

    try {
      const socket = new HandoverSocket(withFlow(wsUrl), async () => {
        if (generation !== this.connectionGeneration) throw new Error('Superseded SIP connection');
        const url = this.directVpn && this.vpnProfile
          ? this.vpnProfile.privateSipUrl
          : this.directFallback
            ? this.directFallback.wsURL
            : gatewaySession
              ? await buildGatewaySipWebSocketUrl(gatewaySession, getSipWss(domain, useTls))
              : getSipWss(domain, useTls);
        if (generation !== this.connectionGeneration) throw new Error('Superseded SIP connection');
        return withFlow(url);
      });
      this.signalingSocket = socket;
      const configuration = {
        sockets: [socket],
        uri: `sip:${extension}@${sipDomain}`,
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
      this.clearSignalingWatchdog();
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
      if (!this.directVpn && this.vpnProfile) {
        this.scheduleDirectRetry();
      }
      this.prefetchMediaConfiguration();
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
      this.armSignalingWatchdog();
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
      connection?: {
        getReceivers?: () => Array<{ track?: MediaStreamTrack }>;
        getStats?: () => Promise<Map<string, Record<string, unknown>>>;
      };
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
    // Outbound targets may expose a provider name. Inbound callers start
    // Unknown and are resolved from the app/Sokrat directories after the
    // call is presented; PBX/SIP labels are not contacts.
    const targetName = session.direction === 'incoming'
      ? 'Unknown'
      : (usableProviderName(target, remoteId?.display_name) || target);

    // ------------------------------------------------------------------
    // Outbound ownership: a new outgoing session may only become a primary
    // call when it belongs to the reserved dial. Anything else is a rejected
    // INVITE, never a replacement for the live call.
    // ------------------------------------------------------------------
    const outboundAttempt = this.outboundAttempt;
    const outboundAttemptCurrent = outboundAttempt !== null &&
      outboundAttempt.ua === this.ua &&
      outboundAttempt.generation === this.connectionGeneration;

    if (session.direction === 'outgoing' && outboundAttempt && !outboundAttemptCurrent) {
      if (this.outboundAttempt === outboundAttempt) this.outboundAttempt = null;
      outboundAttempt.outcome = 'rejected';
      console.warn(`[sip][callId=${callId}] rejected outbound from a superseded connection`);
      try {
        session.terminate();
      } catch (error) {
        console.warn('[sip] outbound rejection failed:', error);
      }
      return;
    }

    // ------------------------------------------------------------------
    // Consultation session routing: if we are waiting for a consult dial
    // and this is a new outgoing session, route it to the consult slot.
    // ------------------------------------------------------------------
    const consultRequested =
      session.direction === 'outgoing' &&
      this.attendedTransfer !== null &&
      this.attendedTransfer.status === 'dialing' &&
      (outboundAttempt === null || outboundAttempt.kind === 'consult');

    if (session.direction === 'outgoing' &&
        outboundAttempt &&
        outboundAttempt.kind === 'consult' &&
        !consultRequested) {
      // The transfer ended while the consultation INVITE was in flight.
      if (this.outboundAttempt === outboundAttempt) this.outboundAttempt = null;
      outboundAttempt.outcome = 'rejected';
      console.warn(`[sip][callId=${callId}] rejected consultation session after transfer ended`);
      try {
        session.terminate();
      } catch (error) {
        console.warn('[sip] consultation rejection failed:', error);
      }
      return;
    }

    const isConsultSession = consultRequested;

    if (isConsultSession && this.attendedTransfer) {
      if (outboundAttempt && this.outboundAttempt === outboundAttempt) {
        this.outboundAttempt = null;
        outboundAttempt.outcome = 'accepted';
      }
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
    // The app currently has one visible call and one session slot. A second
    // incoming INVITE must not replace the active session, otherwise the
    // first PBX bridge can remain up without a UI or hangup path.
    if (session.direction === 'incoming' && this.activeCall &&
        this.activeCall.session !== session) {
      console.warn(
        `[sip][callId=${callId}] rejected incoming while active=${this.activeCall.id}`,
      );
      try {
        session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
      } catch (error) {
        console.warn('[sip] busy rejection failed:', error);
      }
      return;
    }

    // A second primary outbound must never replace the live session either.
    // This also catches an unexpected outgoing INVITE that bypassed call().
    if (session.direction === 'outgoing' &&
        (this.activeCall || this.currentSession) &&
        this.currentSession !== session) {
      if (outboundAttempt && this.outboundAttempt === outboundAttempt) {
        this.outboundAttempt = null;
        outboundAttempt.outcome = 'rejected';
      }
      console.warn(
        `[sip][callId=${callId}] rejected outbound while active=${this.activeCall?.id || 'another session'}`,
      );
      try {
        session.terminate();
      } catch (error) {
        console.warn('[sip] outbound rejection failed:', error);
      }
      return;
    }
    // Only the reserved outgoing session may claim the single primary slot.
    if (session.direction === 'outgoing' && outboundAttempt &&
        this.outboundAttempt === outboundAttempt) {
      this.outboundAttempt = null;
      outboundAttempt.outcome = 'accepted';
    }
    if (session.direction === 'incoming') {
      // Winning once invalidates the old dial even if this call ends before
      // its microphone/TURN promise resolves.
      this.invalidateOutboundAttempt('primary');
    }
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

    // Start TURN/ICE discovery as soon as an inbound INVITE arrives, so the
    // answer path does not wait for a fresh gateway request.
    if (session.direction === 'incoming') this.prefetchMediaConfiguration();

    if (session.direction === 'outgoing') {
      startCallManagers();
      // Play local ringback until carrier early media or a remote track arrives.
      startOutgoingRingback();
      this.armOutgoingRingTimeout(call.id);
      // Publish the call immediately; contact/network lookup never delays dialing.
      call.targetName = usableProviderName(target, remoteId?.display_name) || target;
      this.events.onCallStatusChange?.(call);
      this.startTrunkReconcile(call, target);
      void resolveCallerName(target, {
        extension: this.extension, password: this.password, serverHost: this.serverHost,
        useTls: this.useTls, dnd: false, autoAnswer: false,
      }).then(name => {
        if (this.currentSession !== session || this.activeCall !== call) return;
        call.targetName = usableProviderName(target, name) ||
          usableProviderName(target, call.targetName) || target;
        this.events.onCallStatusChange?.(call);
      });
    }

    // Relay sessions use bounded ICE gathering: first relay candidate + short
    // grace, with a hard cap (a relay-less SDP is never sent). Direct-PBX
    // sessions keep JsSIP's default gathering. Consume the captured mode so a
    // previous call's teardown cannot change this session's media policy.
    const relayRequired = this.pendingRelayRequired ?? this.mediaRelayRequired;
    this.pendingRelayRequired = null;
    this.attachIceGathering(session, call.id, relayRequired);
    this.watchCallHandover(session);
    let lastSdpSummary: SdpLogSummary | null = null;
    let lastSdpType: string | undefined;
    let lastSdpOriginator: string | undefined;

    // Remote audio/early-media wiring.
    //
    // JsSIP creates the RTCPeerConnection *before* it emits `newRTCSession`
    // for an outbound call, so the `peerconnection` event has already fired
    // when this handler is installed. Wiring only the event therefore left
    // outbound calls without remote `track` listeners (early media never
    // published, ringback never stopped) and without codec preferences. Wire
    // the existing connection immediately and keep the event for inbound
    // sessions, which create theirs inside `answer()`.
    const wiredConnections = new WeakSet<object>();

    const applyCodecPreferences = () => {
      const raw = session.connection;
      if (!raw || typeof raw !== 'object') return;
      if (!('getTransceivers' in raw) || typeof raw.getTransceivers !== 'function') return;
      try {
        if (typeof RTCRtpReceiver?.getCapabilities !== 'function') return;
        const audioCaps = RTCRtpReceiver.getCapabilities('audio');
        if (!audioCaps?.codecs) return;
        const preferred = this.preferredCodec === 'auto' ? '' : this.preferredCodec.toLowerCase();
        const allCodecs = audioCaps.codecs as Array<{ mimeType?: string }>;
        let selected = allCodecs;
        if (preferred) {
          const targetCodecs = allCodecs.filter((codec) =>
            (codec.mimeType || '').toLowerCase().includes(preferred));
          if (targetCodecs.length) {
            // Merely sorting capabilities still leaves other codecs in
            // the answer. Restrict the transceiver to the selected codec
            // plus telephone-event so the PBX cannot choose Opus when the
            // user selected PCMU (or the reverse).
            const telephoneEventCodecs = allCodecs.filter((codec) =>
              (codec.mimeType || '').toLowerCase().includes('telephone-event'));
            selected = [...targetCodecs, ...telephoneEventCodecs];
          }
        }
        if (preferred && selected === allCodecs) {
          console.warn(`[sip] preferred codec ${preferred} unavailable; keeping negotiated defaults`);
        } else {
          const transceivers = raw.getTransceivers() as Array<{
            receiver?: { track?: MediaStreamTrack };
            sender?: { track?: MediaStreamTrack };
            setCodecPreferences?: (codecs: unknown[]) => void;
          }>;
          for (const transceiver of transceivers) {
            if (transceiver.receiver?.track?.kind === 'audio' || transceiver.sender?.track?.kind === 'audio') {
              transceiver.setCodecPreferences?.(selected);
            }
          }
          console.log(
            preferred
              ? `[sip] restricted audio codecs to ${preferred}`
              : '[sip] keeping automatic codec negotiation',
          );
        }
      } catch (e) {
        console.warn('[sip] transceiver codec preferences notice:', e);
      }
    };

    const wirePeerConnection = (pc?: unknown) => {
      if (!pc || typeof pc !== 'object' || wiredConnections.has(pc)) return;
      if (!('addEventListener' in pc) || typeof pc.addEventListener !== 'function') return;
      wiredConnections.add(pc);
      // Audio transceivers are created after this point; `connecting` (below)
      // applies the preferences once they exist.
      applyCodecPreferences();

      pc.addEventListener('track', (eventObj: unknown) => {
        const event = eventObj as { track?: MediaStreamTrack };
        console.log('[sip] remote audio track received:', event?.track);
        if (event?.track) {
          event.track.enabled = true;
        }
        // A trailing callback from an ended/superseded leg must never touch
        // whichever call is current now, nor silence its ringback.
        if (this.currentSession !== session) return;
        if (event?.track && event.track.kind !== 'audio') return;
        const call = this.activeCall;
        // A track exists as soon as the remote SDP is applied; it is not
        // proof that the carrier is sending audio yet. Watch for real RTP.
        if (!call) return;
        this.watchEarlyMedia(session, call.id);
      });
      pc.addEventListener('addstream', (eventObj: unknown) => {
        const event = eventObj as { stream?: MediaStream };
        console.log('[sip] remote stream added:', event?.stream);
        if (this.currentSession !== session || !event?.stream) return;
        const call = this.activeCall;
        if (!call) return;
        this.watchEarlyMedia(session, call.id);
      });
    };

    // Outbound sessions already own a peer connection at this point.
    wirePeerConnection(session.connection);
    session.on('peerconnection', (data: unknown) => {
      if (!data || typeof data !== 'object' || !('peerconnection' in data)) return;
      wirePeerConnection(data.peerconnection);
    });
    // Fires after the local media tracks are attached and before the
    // offer/answer is created, so codec preferences can still take effect.
    session.on('connecting', () => {
      applyCodecPreferences();
    });

    // Filter incoming offers before JsSIP applies them to native WebRTC.
    // Its local "sdp" answer event runs AFTER setLocalDescription: pruning
    // codecs there changes the SIP answer but not the native RTP encoder.
    session.on('sdp', (dataObj: unknown) => {
      const data = dataObj as { originator?: string; type?: string; sdp?: string } | undefined;
      if (!data?.sdp) return;
      lastSdpSummary = describeSdpForLog(data.sdp);
      lastSdpType = data.type;
      lastSdpOriginator = data.originator;
      // JsSIP owns SDP application: it serializes the provisional and final
      // answers on its own connection queue and re-offers when the 200 arrives
      // in a stable state. The app must never replay an answer itself.
      // Never rewrite a remote SDP for an outbound call. The offer sent to
      // the PBX is protected by the local-offer filter; a provisional answer
      // must be applied exactly as Asterisk sent it.
      if (data.type === 'offer' &&
          (session.direction === 'incoming' || data.originator === 'local')) {
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
        console.warn(`[sip][callId=${call.id}] media operation failed ${JSON.stringify({
          event,
          name,
          sdpType: lastSdpType,
          sdpOriginator: lastSdpOriginator,
          sdp: lastSdpSummary,
        })}`);
      });
    }
    session.on('progress', () => {
      if (this.currentSession !== session) return;
      if (this.activeCall?.id === call.id) {
        this.activeCall.status = 'ringing';
        this.events.onCallStatusChange?.(this.activeCall);
      }
      this.watchEarlyMedia(session, call.id);
    });
    session.on('accepted', () => {
      if (this.currentSession !== session) return;
      console.log(`[sip][callId=${call.id}] session accepted; waiting for confirmation`);
      if (call.direction === 'outbound') {
        // A 2xx means the callee answered, but the media path is not audible
        // yet. Hold ringback for NetEq's initial playout buffer; `confirmed`
        // re-arms the same hold if it arrives later.
        stopOutgoingRingbackAfterMedia();
        this.armConfirmationTimeout(call.id);
      }
      this.watchEarlyMedia(session, call.id);
    });

    session.on('confirmed', () => {
      if (this.currentSession !== session) return;
      this.stopEarlyMediaWatch();
      this.clearOutgoingTimers();
      if (this.activeCall?.id === call.id) {
        this.activeCall.status = 'active';
        if (!this.activeCall.startTime) this.activeCall.startTime = Date.now();
        console.log(`[sip][callId=${call.id}] session confirmed`);
        this.events.onCallEstablished(this.activeCall);
        this.events.onCallStatusChange?.(this.activeCall);
        void this.setLiveMicGain(this.micGainDb, this.activeCall.id);
        this.setSpeakerVolume(this.speakerVolume);
      }
      this.attachEarlyMediaAudio(session, call);
      stopOutgoingRingbackAfterMedia();
      this.startMicAgc(session);
      this.startMediaDiagnostics(session);
    });

    session.on('ended', (evt: unknown) => {
      logTermination('ended', evt);
      if (this.currentSession !== session) return;
      if (this.answerDispatchedSession === session) this.answerDispatchedSession = null;
      this.clearOutgoingTimers();
      this.clearSignalingWatchdog();
      stopOutgoingRingback();
      this.stopEarlyMediaWatch();
      this.stopTrunkReconcile();
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
      this.clearOutgoingTimers();
      this.clearSignalingWatchdog();
      stopOutgoingRingback();
      this.stopEarlyMediaWatch();
      this.stopTrunkReconcile();
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
      this.attachEarlyMediaAudio(session, consultCall);
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
      this.attachEarlyMediaAudio(session, consultCall);
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
    this.invalidateOutboundAttempt('consult');
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
    this.invalidateOutboundAttempt('consult');
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

    // Place consultation call — handleNewRTCSession will route it to consultSession.
    // The private path reserves the one consult slot without tripping the
    // primary-dial guard, which correctly rejects ordinary calls while a
    // primary or consultation leg exists.
    await this.dialOutbound(targetExtension, 'consult');
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

  /**
   * Keep microphone AGC alive for the full call, independent of the bounded
   * media-diagnostics capture. Stats failures are retried; a failed request
   * must not silently freeze the gain for the rest of the call.
   */
  private startMicAgc(session: {
    connection?: { getStats?: () => Promise<Map<string, Record<string, unknown>>> };
    on: (event: string, listener: () => void) => void;
  }): void {
    const connection = session.connection;
    if (this.currentSession !== session || typeof connection?.getStats !== 'function') return;
    this.stopMicAgc?.();
    const generation = this.connectionGeneration;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastFailureLog = 0;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      if (this.stopMicAgc === stop) this.stopMicAgc = null;
    };
    const current = () => !stopped && this.currentSession === session &&
      this.connectionGeneration === generation;
    const schedule = (delayMs = 2000) => {
      if (!stopped) timer = setTimeout(() => { void sample(); }, delayMs);
    };

    this.micAgcGainDb = MIC_AGC_CENTER_DB;
    this.micAgcSuspended = false;
    if (this.activeCall) {
      void this.setLiveMicGain(MIC_AGC_CENTER_DB, this.activeCall.id);
    }

    const sample = async () => {
      if (!current()) { stop(); return; }
      if (this.micAgcPending) {
        schedule(500);
        return;
      }
      this.micAgcPending = true;
      try {
        const stats = await connection.getStats!();
        if (!current()) return;
        const level = getMediaSourceAudioLevel(stats);
        if (level !== null && this.activeCall && !this.micAgcSuspended) {
          const nextGain = nextMicAgcGain(this.micAgcGainDb, level);
          if (Math.abs(nextGain - this.micAgcGainDb) >= 0.01) {
            this.micAgcGainDb = nextGain;
            void this.setLiveMicGain(nextGain, this.activeCall.id);
          }
        }
      } catch {
        if (current()) {
          const now = Date.now();
          if (now - lastFailureLog >= 30_000) {
            lastFailureLog = now;
            console.warn('[sip] microphone AGC statistics unavailable; retrying');
          }
        }
      } finally {
        this.micAgcPending = false;
        schedule();
      }
    };

    this.stopMicAgc = stop;
    session.on('ended', stop);
    session.on('failed', stop);
    void sample();
  }

  private startMediaDiagnostics(session: {
    connection?: { getStats?: () => Promise<Map<string, Record<string, unknown>>> };
    on: (event: string, listener: () => void) => void;
  }): void {
    const connection = session.connection;
    if (this.currentSession !== session || typeof connection?.getStats !== 'function') return;
    this.stopMediaDiagnostics?.();
    const generation = this.connectionGeneration;
    const startedAt = Date.now();
    const summarize = createAudioStatsSummarizer();
    let writeCounters = getMediaDiagnosticsWriter();
    let fileWritePending = false;
    let resetCounterFile = true;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(deadline);
      if (this.stopMediaDiagnostics === stop) this.stopMediaDiagnostics = null;
    };
    const current = () => !stopped && this.currentSession === session &&
      this.connectionGeneration === generation;
    const sample = async () => {
      if (!current()) { stop(); return; }
      if (this.mediaStatsPending) return;
      this.mediaStatsPending = true;
      try {
        const stats = await connection.getStats!();
        if (current()) {
          const now = Date.now();
          const serialized = JSON.stringify({
            startedAtUnixMs: startedAt,
            timestampUnixMs: now,
            elapsedMs: now - startedAt,
            speakerVolumePercent: this.speakerVolume,
            ...summarize(stats),
          });
          console.info(`[media] ${serialized}`);
          if (writeCounters && !fileWritePending) {
            fileWritePending = true;
            writeCounters(serialized, resetCounterFile)
              .then(() => { resetCounterFile = false; })
              .catch(() => {
                writeCounters = null;
                console.warn('[media] local counter export unavailable');
              })
              .finally(() => { fileWritePending = false; });
          }
        }
      } catch {
        if (current()) console.warn('[media] statistics unavailable');
        stop();
      } finally {
        this.mediaStatsPending = false;
      }
    };
    this.stopMediaDiagnostics = stop;
    session.on('ended', stop);
    session.on('failed', stop);
    deadline = setTimeout(stop, 600_000);
    timer = setInterval(() => { void sample(); }, 2000);
    void sample();
  }

  /**
   * Publish remote audio for the call and silence the local ringback.
   *
   * Only called once playable audio exists (verified RTP, or a confirmed call):
   * the receiver tracks returned by `getReceivers()` exist as soon as the
   * local audio transceiver is created, so a 180 Ringing must not reach here.
   */
  private attachEarlyMediaAudio(
    session: { connection?: unknown },
    call: ActiveCall | null = this.activeCall,
  ) {
    // Async media callbacks from an ended/superseded leg must not touch a
    // newer call.
    if (!call || call.session !== session) return;
    if (this.activeCall !== call && this.consultCall !== call) return;
    const pc = earlyMediaConnection(session);
    if (!pc) return;
    if (!remoteAudioSends(pc.remoteDescription?.sdp)) return;
    const tracks = audioReceiverTracks(pc);
    if (tracks.length === 0) return;
    call.remoteStream = new MediaStream(tracks);
    stopOutgoingRingbackAfterMedia();
    this.setSpeakerVolume(this.speakerVolume);
  }

  /**
   * Poll native RTP statistics until the carrier is actually sending early
   * media, then publish it and stop the local ringback.
   *
   * A `track` event is not proof of media: RN-WebRTC creates the audio
   * receiver from our own transceiver as soon as the remote SDP is applied,
   * and its only native mute/unmute events come from the remote *video* track
   * adapter — audio tracks have no equivalent event. Received RTP is the
   * concrete signal, and until it arrives the local ringback keeps playing.
   *
   * The poll runs for the whole ringing lifetime of the call, with no expiry:
   * a carrier can start its announcement many seconds after the 183, and no
   * further event fires when the first RTP packet arrives. Confirmation,
   * failure, or any teardown stops it.
   */
  private watchEarlyMedia(session: { connection?: unknown }, callId: string): void {
    if (this.currentSession !== session) return;
    if (!this.activeCall || this.activeCall.id !== callId) return;
    // Early media only exists for an outgoing call: the caller's 183 arrives
    // before our answer, which is already sent on the inbound path.
    if (this.activeCall.direction !== 'outbound') return;
    if (this.earlyMediaWatchCall === callId) return;
    this.stopEarlyMediaWatch();
    this.earlyMediaWatchCall = callId;
    const tick = async () => {
      this.earlyMediaTimer = null;
      if (this.earlyMediaWatchCall !== callId) return;
      if (this.currentSession !== session) return;
      if (!this.activeCall || this.activeCall.id !== callId) return;
      let receiving = false;
      try {
        receiving = await this.earlyMediaReceiving(session);
      } catch {
        receiving = false;
      }
      // Re-check identity after the async stats sample: the call may have been
      // confirmed, ended, or replaced while it was in flight.
      if (this.earlyMediaWatchCall !== callId) return;
      if (this.currentSession !== session) return;
      if (!this.activeCall || this.activeCall.id !== callId) return;
      if (receiving) {
        this.stopEarlyMediaWatch();
        this.attachEarlyMediaAudio(session, this.activeCall);
        return;
      }
      this.earlyMediaTimer = setTimeout(() => { void tick(); }, EARLY_MEDIA_POLL_MS);
    };
    void tick();
  }

  /** Whether the peer connection currently carries real inbound audio. */
  private async earlyMediaReceiving(session: { connection?: unknown }): Promise<boolean> {
    const pc = earlyMediaConnection(session);
    if (!pc) return false;
    // No remote description or a non-sending audio section means no early
    // media is possible yet (e.g. 180 Ringing without SDP).
    if (!remoteAudioSends(pc.remoteDescription?.sdp)) return false;
    if (audioReceiverTracks(pc).length === 0) return false;
    // Only received RTP proves early media. Without a stats API there is no
    // evidence, so the local ringback stays in charge until confirmation.
    if (typeof pc.getStats !== 'function') return false;
    const stats = await pc.getStats();
    return hasInboundAudio(stats);
  }

  /** Cancel the early-media readiness poll (confirmation or teardown). */
  private stopEarlyMediaWatch(): void {
    this.earlyMediaWatchCall = null;
    clearTimeout(this.earlyMediaTimer);
    this.earlyMediaTimer = null;
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
    relayRequired = this.mediaRelayRequired,
  ) {

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
  private prefetchMediaConfiguration(): void {
    // Failures are handled by the answer path; an inbound call must still ring.
    void this.resolveMediaConfiguration().catch(() => {});
  }

  /**
   * The App may reset the active gateway generation while a SIP registration
   * is still running (startup remount/account restore). Do not keep using a
   * session object from the previous generation: fetch the current one before
   * minting relay credentials, otherwise JsSIP rejects the call locally.
   */
  private async resolveMediaGatewaySession(domain: string): Promise<GatewaySession | null> {
    if (this.directSip) return null;
    if (this.directVpn) return null;
    if (this.directFallback) return null;
    const active = getActiveGatewaySession(domain, this.extension);
    if (active) {
      this.gatewaySession = active;
      return active;
    }
    if (this.gatewaySession) {
      console.warn('[sip] gateway session changed; refreshing media session');
    }
    const refreshed = await getOrLoadGatewaySession(domain, this.extension);
    this.gatewaySession = refreshed;
    return refreshed;
  }

  private async resolveMediaConfiguration(): Promise<MediaConfiguration> {
    const domain = this.directVpn && this.vpnProfile
      ? this.vpnProfile.sipDomain
      : (this.serverHost || CONFIG.sipDomain);
    const gatewaySession = await this.resolveMediaGatewaySession(domain);
    const mediaHost = this.directVpn && this.vpnProfile
      ? this.vpnProfile.sipDomain
      : (this.directFallbackHost || domain);
    const cacheKey = gatewaySession
      ? `gateway:${gatewaySession.apiURL}:${gatewaySession.deviceId}:${gatewaySession.assignment.pbxId}:${gatewaySession.assignment.extension}`
      : `direct:${mediaHost}:${this.extension}:${this.connectionGeneration}`;
    const now = Date.now();
    if (this.mediaConfigurationCache?.key === cacheKey &&
        this.mediaConfigurationCache.expiresAt > now) {
      return this.mediaConfigurationCache.promise;
    }

    const generation = this.connectionGeneration;
    const promise = (async () => {
      let mediaConfiguration: MediaConfiguration;
      if (gatewaySession) {
        // TURN credentials from the assigned PBX; normal ICE may use direct
        // host/srflx candidates when they are available.
        mediaConfiguration = await gatewayMediaConfiguration(gatewaySession);
      } else {
        mediaConfiguration = this.directFallback
          ? await getMediaConfiguration(mediaHost, this.extension, this.password,
            { apiURL: this.directFallback.apiURL })
          : await getMediaConfiguration(mediaHost, this.extension, this.password);
      }
      if (generation !== this.connectionGeneration) {
        throw new Error('Media configuration superseded by a newer connection');
      }
      this.mediaRelayRequired = mediaConfiguration.iceTransportPolicy === 'relay';
      return mediaConfiguration;
    })();

    const entry = {
      key: cacheKey,
      expiresAt: now + 4 * 60 * 1000,
      promise,
    };
    this.mediaConfigurationCache = entry;
    try {
      const mediaConfiguration = await promise;
      this.mediaRelayRequired = mediaConfiguration.iceTransportPolicy === 'relay';
      return mediaConfiguration;
    } catch (error) {
      if (this.mediaConfigurationCache === entry) this.mediaConfigurationCache = null;
      throw error;
    }
  }

  /**
   * Acquire unclaimed microphone audio. The caller must still own its session
   * before publishing this stream or changing live microphone gain.
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
        // The route is normally applied before capture starts. Re-assert the
        // preferred physical microphone after AudioRecord exists so devices
        // whose policy re-selects input on route setup still use the requested
        // handset path from the first packet.
        setPreferredCallInputDevice(getAudioDeviceState().selectedDevice);
        console.log(`[sip] microphone acquired tracks=${tracks.length}`);
        const finalStream = tracks.length > 0 ? stream : null;
        resolve(finalStream);
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
    await this.dialOutbound(target, 'primary');
  }

  /**
   * Reserve the next outgoing INVITE before microphone/TURN work, then
   * revalidate this attempt after every await. JsSIP emits newRTCSession
   * synchronously before sending the INVITE, so a rejected/superseded
   * attempt can never replace a live primary or consultation session.
   */
  private async dialOutbound(target: string, kind: OutboundCallKind): Promise<void> {
    const ua = this.ua;
    if (!ua || !ua.isRegistered()) {
      throw new Error('Softphone is not registered');
    }
    if (this.outboundAttempt) {
      throw new Error('Another call is already in progress');
    }
    if (kind === 'primary') {
      if (this.activeCall || this.currentSession || this.attendedTransfer) {
        throw new Error('Another call is already in progress');
      }
    } else if (
      !this.activeCall ||
      !this.attendedTransfer ||
      this.attendedTransfer.status !== 'dialing' ||
      this.activeCall.id !== this.attendedTransfer.originalCallId
    ) {
      throw new Error('No consultation call is waiting to be placed');
    }

    const attempt: OutboundCallAttempt = {
      kind,
      ua,
      generation: this.connectionGeneration,
      stream: null,
      ownsStream: false,
      outcome: 'pending',
    };
    this.outboundAttempt = attempt;

    let relayOwned = false;
    const preexistingStream = this.localStream;
    const preexistingSession = this.currentSession;
    try {
      const localStream = await this.getLocalAudioStream();
      if (!localStream) throw new Error('Microphone unavailable');
      attempt.stream = localStream;
      // A returning implementation (or a deliberately shared capture) may hand
      // back the primary/consult stream that already belongs to this service.
      // That stream is borrowed and must never be stopped by this attempt.
      attempt.ownsStream = localStream !== preexistingStream &&
        localStream !== this.localStream;

      if (!this.canDispatchOutbound(attempt)) {
        throw new Error('Outbound call was superseded by another call or connection');
      }

      const domain = this.directVpn && this.vpnProfile
        ? this.vpnProfile.sipDomain
        : (this.serverHost || CONFIG.sipDomain);
      const targetUri = `sip:${target}@${domain}`;

      // Relay credentials are mandatory on public servers: abort the call
      // (and release this attempt's microphone) instead of connecting without audio.
      const mediaConfiguration = await this.resolveMediaConfiguration();
      if (!this.canDispatchOutbound(attempt)) {
        throw new Error('Outbound call was superseded by another call or connection');
      }

      const options: Record<string, unknown> = {
        mediaConstraints: { audio: true, video: false },
        pcConfig: {
          ...mediaConfiguration,
          // Media must stay UDP: never offer ICE-TCP host candidates, so a
          // UDP-blocked network fails the call instead of silently using TCP.
          tcpCandidatePolicy: 'disabled',
          iceCandidatePoolSize: 2,
          // Best measured receive ceiling: 50 packets (1 second at 20 ms).
          audioJitterBufferMaxPackets: 50,
          audioJitterBufferFastAccelerate: true,
        },
        sessionTimersExpires: 120,
      };
      options.mediaStream = localStream;
      // Never repoint the service at a borrowed stream: the live primary still
      // owns it, and a newer call may already have replaced the pointer.
      if (attempt.ownsStream) {
        this.localStream = localStream;
        this.setMicVolume(this.micVolume);
      }
      // Only an explicit relay-only configuration waits for TURN. Gateway mode
      // otherwise uses the same direct/host path as any WebRTC call. The
      // consultation branch reads mediaRelayRequired directly, so a pending
      // flag here would leak into the next primary call.
      if (kind === 'primary') {
        this.pendingRelayRequired = this.mediaRelayRequired
          || mediaConfiguration.iceTransportPolicy === 'relay';
        relayOwned = true;
      }
      ua.call(targetUri, options);
      if (attempt.outcome === 'rejected') {
        throw new Error('Outbound call was rejected by another active call');
      }
      if (attempt.outcome === 'pending' && relayOwned) {
        // No synchronous session consumed the relay claim (JsSIP always emits
        // newRTCSession synchronously); do not leave it for a later call.
        this.pendingRelayRequired = null;
      }
      // The synchronous newRTCSession handler consumed the reservation for an
      // accepted call. Never leave a dead reservation behind if it did not.
      attempt.stream = null;
      if (this.outboundAttempt === attempt) this.outboundAttempt = null;
    } catch (err) {
      if (this.outboundAttempt === attempt) this.outboundAttempt = null;
      if (attempt.outcome !== 'accepted') {
        if (kind === 'consult' && attempt.ownsStream &&
            this.localStream === attempt.stream &&
            this.currentSession === preexistingSession &&
            this.ua === ua &&
            this.connectionGeneration === attempt.generation) {
          this.localStream = preexistingStream;
        }
        this.releaseCapturedStream(attempt);
      }
      if (relayOwned && attempt.outcome !== 'accepted') this.pendingRelayRequired = null;
      if (!this.activeCall && !this.currentSession && !this.outboundAttempt &&
          this.ua === ua && this.connectionGeneration === attempt.generation) {
        this.mediaRelayRequired = false;
      }
      console.error('[sip] outbound call dispatch failed:', err);
      throw err;
    }
  }

  /** Whether this exact attempt still owns the primary/consult slot and UA. */
  private canDispatchOutbound(attempt: OutboundCallAttempt): boolean {
    if (this.outboundAttempt !== attempt ||
        this.connectionGeneration !== attempt.generation ||
        this.ua !== attempt.ua ||
        !attempt.ua.isRegistered()) {
      return false;
    }
    if (attempt.kind === 'consult') {
      return this.activeCall !== null &&
        this.attendedTransfer !== null &&
        this.attendedTransfer.status === 'dialing' &&
        this.activeCall.id === this.attendedTransfer.originalCallId;
    }
    return this.activeCall === null &&
      this.currentSession === null &&
      this.attendedTransfer === null;
  }

  /** A cancelled request cannot regain ownership after a later call ends. */
  private invalidateOutboundAttempt(kind: OutboundCallKind): void {
    const attempt = this.outboundAttempt;
    if (!attempt || attempt.kind !== kind) return;
    this.outboundAttempt = null;
    attempt.outcome = 'rejected';
    this.releaseCapturedStream(attempt);
  }

  /** Release only microphone audio owned by a failed media preparation. */
  private releaseCapturedStream(attempt: LocalAudioCapture): void {
    const stream = attempt.stream;
    attempt.stream = null;
    if (!stream || !attempt.ownsStream) return;
    if (this.localStream === stream) {
      this.releaseLocalStream();
      return;
    }
    try {
      const tracks = stream.getTracks ? stream.getTracks() : [];
      for (const track of tracks) {
        try {
          track.stop();
        } catch {}
      }
    } catch (err) {
      console.warn('[sip] failed to release superseded capture:', err);
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

    const ua = this.ua;
    const generation = this.connectionGeneration;
    const preexistingStream = this.localStream;
    const stillCurrent = () => this.currentSession === session &&
      this.activeCall === activeCall && this.ua === ua &&
      this.connectionGeneration === generation;
    // Microphone acquisition and relay discovery are independent. Run them
    // together so the answer path pays the slower cost, not the sum.
    const localStreamPromise = this.getLocalAudioStream();
    const mediaConfigurationPromise = this.resolveMediaConfiguration();
    const [streamResult, configurationResult] = await Promise.allSettled([
      localStreamPromise,
      mediaConfigurationPromise,
    ]);
    const localStream = streamResult.status === 'fulfilled' ? streamResult.value : null;
    const capture: LocalAudioCapture = {
      stream: localStream,
      ownsStream: localStream !== null && localStream !== preexistingStream &&
        localStream !== this.localStream,
    };
    if (!stillCurrent()) {
      this.releaseCapturedStream(capture);
      return false;
    }

    if (configurationResult.status === 'rejected') {
      this.mediaRelayRequired = false;
      this.releaseCapturedStream(capture);
      console.error(
        `[sip][callId=${callId}] answer blocked: media configuration failed:`,
        configurationResult.reason,
      );
      return false;
    }
    if (!localStream) {
      this.mediaRelayRequired = false;
      console.error(`[sip][callId=${callId}] answer blocked: microphone unavailable`);
      return false;
    }
    if (capture.ownsStream) {
      this.localStream = localStream;
      this.setMicVolume(this.micVolume);
    }
    const mediaConfiguration = configurationResult.value;

    // Bounded ICE gathering depends on the media mode that `answer()` will
    // actually use; the initial listener (attached at newRTCSession) cannot
    // know it yet, so re-arm right after the peer connection exists.
    const options: Record<string, unknown> = {
      mediaConstraints: { audio: true, video: false },
      mediaStream: localStream,
      pcConfig: {
        ...mediaConfiguration,
        // Media must stay UDP: never offer ICE-TCP host candidates, so a
        // UDP-blocked network fails the call instead of silently using TCP.
        tcpCandidatePolicy: 'disabled',
        iceCandidatePoolSize: 2,
        audioJitterBufferMaxPackets: 50,
        audioJitterBufferFastAccelerate: true,
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
      if (stillCurrent()) {
        this.mediaRelayRequired = false;
        this.releaseCapturedStream(capture);
      }
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
    this.clearOutgoingTimers();
    this.clearSignalingWatchdog();
    stopOutgoingRingback();
    this.stopEarlyMediaWatch();
    this.stopTrunkReconcile();
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
    this.clearOutgoingTimers();
    this.clearSignalingWatchdog();
    stopOutgoingRingback();
    this.stopEarlyMediaWatch();
    this.stopTrunkReconcile();
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

  /**
   * Mark the selected service call as held by a GSM/cellular preemption.
   * Keeping the flag on the service-owned call prevents the UI copy from
   * holding one object while auto-resume checks a different one.
   */
  setGsmInterrupted(interrupted: boolean): boolean {
    const call = this.activeCall;
    if (!call) return false;
    if (interrupted) {
      if (call.status !== 'active' || call.isHeld) return false;
      call.isGsmInterrupted = true;
      this.setHold(true);
      return true;
    }
    if (!call.isGsmInterrupted) return false;
    call.isGsmInterrupted = false;
    this.setHold(false);
    return true;
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

  private scheduleDirectRetry() {
    if (this.directRetryAttempts > 0 || this.directVpn || !this.vpnProfile) return;
    if (this.activeCall || this.state !== 'registered') return;
    clearTimeout(this.directRetryTimer ?? undefined);
    const generation = this.connectionGeneration;
    this.directRetryTimer = setTimeout(() => {
      this.directRetryTimer = null;
      if (generation !== this.connectionGeneration) return;
      if (this.directVpn || this.activeCall || this.state !== 'registered') return;
      this.directRetryAttempts += 1;
      console.log('[sip] retrying the embedded VPN after its handshake had time to complete');
      void this.forceReconnect();
    }, 15000);
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

  handleNetworkChange(network: { isConnected: boolean; networkType: string; networkId?: string }): void {
    const previous = this.lastNetworkState;
    // networkId catches Wi-Fi A → Wi-Fi B and cell A → cell B, where Android
    // reports the same transport type but the default network has changed.
    const changed = previous !== null &&
      (previous.isConnected !== network.isConnected ||
       previous.networkType !== network.networkType ||
       (previous.networkId || '') !== (network.networkId || ''));
    this.lastNetworkState = {
      isConnected: network.isConnected,
      networkType: network.networkType,
      networkId: network.networkId,
    };

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
    session.on('confirmed', () => {
      // Only a recovery queued while ringing needs this deferral. Without the
      // guard every normal call leaves a timer alive after teardown.
      if (!this.mediaRecovery.has(session) || this.mediaRecoveryConfirmTimers.has(session)) return;
      // A recovery queued while the call was still ringing used to send an
      // ICE restart in the same tick as confirmation, racing the first RTP
      // and DTLS setup. Give the fresh media path a moment; recoverCallMedia()
      // skips the re-offer if inbound audio is already flowing.
      const timer = setTimeout(() => {
        this.mediaRecoveryConfirmTimers.delete(session);
        if (!this.mediaRecovery.has(session)) return;
        void this.recoverCallMedia();
      }, MEDIA_RECOVERY_CONFIRM_DELAY_MS);
      this.mediaRecoveryConfirmTimers.set(session, timer);
    });
    const cleanup = () => {
      const confirmTimer = this.mediaRecoveryConfirmTimers.get(session);
      if (confirmTimer) {
        clearTimeout(confirmTimer);
        this.mediaRecoveryConfirmTimers.delete(session);
      }
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

  private async mediaPathHealthy(session: RecoverableSession): Promise<boolean> {
    const connection = session.connection as {
      getStats?: () => Promise<Map<string, unknown> | null | undefined>;
    } | undefined;
    if (typeof connection?.getStats !== 'function') return false;
    try {
      return hasInboundAudio(await connection.getStats());
    } catch {
      return false;
    }
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
        if (await this.mediaPathHealthy(session)) {
          this.mediaRecovery.delete(session);
          console.log('[sip] media recovery skipped; inbound RTP already flowing');
          continue;
        }
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
    for (const timer of this.mediaRecoveryConfirmTimers.values()) clearTimeout(timer);
    this.mediaRecoveryConfirmTimers.clear();
    this.mediaRecovery.clear();
    this.mediaRecoveryRun = null;
    this.answerDispatchedSession = null;
    this.clearOutgoingTimers();
    this.clearSignalingWatchdog();
    stopOutgoingRingback();
    this.stopEarlyMediaWatch();
    this.stopTrunkReconcile();
    clearTimeout(this.liveGainTimer ?? undefined);
    this.liveGainTimer = null;
    this.liveGainResolve?.(false);
    this.liveGainResolve = null;
    this.pendingGainDb = null;
    this.stopMediaDiagnostics?.();
    this.stopMediaDiagnostics = null;
    this.stopMicAgc?.();
    this.stopMicAgc = null;
    this.connectionGeneration += 1;
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
    clearTimeout(this.directRetryTimer ?? undefined);
    this.directRetryTimer = null;
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
    // Clear transfer slots before SDK teardown: late consult callbacks must
    // not restore the old primary, even if ua.stop() fails.
    const hadTransfer = this.attendedTransfer !== null;
    this.attendedTransfer = null;
    this.consultSession = null;
    this.consultCall = null;
    this.primaryCall = null;
    this.primaryManualHold = false;
    if (hadTransfer) this.events.onAttendedTransferChange?.(null);
    if (ua) {
      try {
        ua.stop();
      } catch {}
    }
    this.signalingSocket = null;
    this.currentSession = null;
    this.activeCall = null;
    const outbound = this.outboundAttempt;
    this.outboundAttempt = null;
    if (outbound && outbound.outcome !== 'accepted') {
      this.releaseCapturedStream(outbound);
    }
    this.releaseLocalStream();
    this.pendingRelayRequired = null;
    this.mediaRelayRequired = false;
    this.mediaConfigurationCache = null;
    this.gatewaySession = null;
    this.directFallback = null;
    this.directFallbackHost = '';
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
   * Whether the phone is busy with a primary/consult session or a dial that
   * has reserved the next outgoing INVITE. Consumers use this to keep audio
   * managers alive for a rejected second dial instead of tearing down the
   * live call they are actually in.
   */
  hasCallInProgress(): boolean {
    return this.activeCall !== null ||
      this.currentSession !== null ||
      this.consultSession !== null ||
      this.outboundAttempt !== null;
  }
  /**
   * Restrict the audio offer to the user's preferred codec when offered,
   * preserving other media sections and enabling inband FEC for Opus.
   */
  private prioritizeCodecInSdp(sdp: string, preferred: CodecPreference): string {
    if (!sdp) return sdp;

    const allLines = sdp.split('\r\n');
    const audioStart = allLines.findIndex((line) => line.startsWith('m=audio '));
    if (audioStart < 0) return sdp;
    const nextMedia = allLines.findIndex((line, index) =>
      index > audioStart && line.startsWith('m='));
    const audioEnd = nextMedia < 0 ? allLines.length : nextMedia;
    const lines = allLines.slice(audioStart, audioEnd);
    const offeredPayloads = new Set(lines[0].split(' ').slice(3));
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
        if (codecName === targetCodec && offeredPayloads.has(pt)) {
          targetPayload = pt;
          break;
        }
      }
    }

    const keepPayloads = targetPayload
      ? new Set([
          targetPayload,
          ...Object.entries(payloadToCodec)
            .filter(([, codecName]) => codecName === 'telephone-event')
            .map(([pt]) => pt),
        ])
      : null;

    // 2. Restrict m=audio to the selected codec. Reordering alone is not
    // enough: Asterisk may still select its own preferred codec (often Opus)
    // from the remaining payload list. Keep telephone-event for DTMF.
    const updatedLines = lines
      .map((line) => {
        if (keepPayloads && line.startsWith('m=audio ')) {
          const parts = line.split(' ');
          if (parts.length > 3) {
            const prefix = parts.slice(0, 3);
            const payloads = parts.slice(3).filter((p) => keepPayloads.has(p));
            if (payloads.length) {
              return `${prefix.join(' ')} ${payloads.join(' ')}`;
            }
          }
        }
        return line;
      })
      .filter((line) => {
        if (!keepPayloads) return true;
        const match = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)(?:\s|$)/i.exec(line);
        return !match || keepPayloads.has(match[1]);
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
    return [
      ...allLines.slice(0, audioStart),
      ...updatedLines,
      ...allLines.slice(audioEnd),
    ].join('\r\n');
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
