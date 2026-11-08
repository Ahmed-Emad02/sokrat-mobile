/**
 * Runtime gateway session.
 *
 * Holds the approved device credential and provides the gateway-backed
 * equivalents of the legacy helpers:
 *   - SIP WebSocket URL (always the gateway's own public endpoint, never the
 *     assignment's upstream PBX URL) with a freshly minted one-use ticket
 *   - TURN relay configuration (force relay)
 *   - authenticated push registration
 *
 * Every authenticated gateway API is addressed at the gateway origin derived
 * from the configured host; the assignment's PBX `apiURL` is never used as a
 * client origin (see `createGatewaySession`).
 *
 * `getOrLoadGatewaySession()` is also the fail-closed gate: once a host has a
 * gateway enrollment record, SIP/media must go through the gateway even if the
 * assignment is missing (pending/revoked) — never the direct PBX path.
 */
import { isPrivateHost, splitHost, type MediaConfiguration } from '../network';
import { getSipWss } from '../config';
import { GatewayClient } from './client';
import { GatewayError, failClosed } from './errors';
import { isKnownGatewayHost, loadEnrollmentRecord, saveEnrollmentRecord } from './storage';
import type { EnrollmentRecord, GatewayAssignment, GatewayCallState, GatewaySession, GatewayEndpoint } from './types';
import { appendQuery, gatewayBaseUrl, gatewaySipWssUrl, normalizeServerHost } from './urls';

let activeSession: GatewaySession | null = null;
let sessionGeneration = 0;
const generations = new WeakMap<GatewaySession, number>();

export function getGatewaySessionGeneration(): number {
  return sessionGeneration;
}

export function assertGatewaySessionGeneration(generation: number): void {
  if (generation !== sessionGeneration) throw new GatewayError('aborted', 'Gateway account changed');
}

function assertCurrentSession(session: GatewaySession): void {
  assertGatewaySessionGeneration(generations.get(session) ?? -1);
  if (activeSession && (activeSession.host !== session.host || activeSession.extension !== session.extension || activeSession.deviceId !== session.deviceId)) {
    throw new GatewayError('aborted', 'Gateway account changed');
  }
}

async function invalidateSession(session: GatewaySession, error: unknown): Promise<void> {
  if (!(error instanceof GatewayError) || !['unauthorized', 'revoked', 'rejected', 'expired', 'pbx_disabled'].includes(error.kind)) return;
  assertCurrentSession(session);
  resetGatewaySession();
  // Local and cloud credentials are separate. A local failure updates only
  // the local enrollment record; the cloud record is never touched.
  if (session.endpointId === 'fallback') {
    const local = await loadEnrollmentRecord(session.endpointHost || session.host, session.extension);
    if (local && local.deviceId === session.deviceId) {
      await saveEnrollmentRecord({ ...local, status: error.kind === 'pbx_disabled' ? 'pbx_disabled' : 'revoked', assignment: undefined });
    }
    return;
  }
  const record = await loadEnrollmentRecord(session.host, session.extension);
  if (record && record.deviceId === session.deviceId) {
    await saveEnrollmentRecord({ ...record, status: error.kind === 'pbx_disabled' ? 'pbx_disabled' : 'revoked', assignment: undefined });
  }
}

async function sessionRequest<T>(session: GatewaySession, request: () => Promise<T>): Promise<T> {
  assertCurrentSession(session);
  try {
    const result = await request();
    assertCurrentSession(session);
    return result;
  } catch (error) {
    await invalidateSession(session, error);
    throw error;
  }
}

export function createGatewaySession(
  host: string,
  claimSecret: string,
  deviceId: string,
  assignment: GatewayAssignment,
  endpoint?: GatewayEndpoint,
): GatewaySession {
  const normalizedHost = normalizeServerHost(host);
  const selected: GatewayEndpoint = endpoint || {
    id: 'primary',
    role: 'primary',
    host: normalizedHost,
    apiURL: gatewayBaseUrl(normalizedHost),
    sipWssUrl: gatewaySipWssUrl(normalizedHost, 'primary'),
  };
  const session: GatewaySession = {
    host: normalizedHost,
    extension: assignment.extension,
    deviceId,
    claimSecret,
    assignment,
    // The assignment's apiURL is the PBX upstream and must never be used here.
    apiURL: selected.apiURL,
    sipWssUrl: selected.sipWssUrl,
    endpointId: selected.id,
    endpointHost: selected.host,
  };
  generations.set(session, sessionGeneration);
  return session;
}

export function setActiveGatewaySession(session: GatewaySession | null): void {
  if (session) assertCurrentSession(session);
  activeSession = session;
}

export function resetGatewaySession(): void {
  sessionGeneration += 1;
  activeSession = null;
}

export function getActiveGatewaySession(
  host?: string,
  extension?: string,
): GatewaySession | null {
  if (!activeSession) return null;
  if (host && activeSession.host !== normalizeServerHost(host)) return null;
  if (extension && activeSession.extension !== extension.trim()) return null;
  return activeSession;
}

function sessionFromRecord(record: EnrollmentRecord, endpoint?: GatewayEndpoint, hostOverride?: string): GatewaySession {
  if (record.status !== 'approved' || !record.assignment || record.assignment.extension !== record.extension) {
    throw failClosed('Device approval is still pending; direct PBX fallback is disabled');
  }
  if (!record.deviceId) {
    throw failClosed('Enrollment record has no device id');
  }
  return createGatewaySession(hostOverride || record.host, record.claimSecret, record.deviceId, record.assignment, endpoint);
}

/**
 * Return the active session, hydrate it from the persisted approved assignment,
 * or `null` when this host is a plain direct-PBX deployment.
 *
 * A persisted gateway record without an approved assignment throws: callers
 * must not silently bypass the gateway.
 */
export async function getOrLoadGatewaySession(
  host: string,
  extension: string,
): Promise<GatewaySession | null> {
  const generation = sessionGeneration;
  const record = await loadEnrollmentRecord(host, extension);
  assertGatewaySessionGeneration(generation);
  if (!record || !record.gatewayMode) {
    if (getActiveGatewaySession(host, extension)) throw failClosed('Gateway enrollment record is unavailable');
    const known = await isKnownGatewayHost(host);
    assertGatewaySessionGeneration(generation);
    if (known) throw failClosed('This gateway account requires enrollment');
    return null;
  }
  if (record.status === 'rejected' || record.status === 'revoked') {
    resetGatewaySession();
    throw new GatewayError(record.status, 'Device enrollment is no longer valid');
  }

  const primary: GatewayEndpoint = {
    id: 'primary',
    role: 'primary',
    host: record.host,
    apiURL: gatewayBaseUrl(record.host),
    sipWssUrl: gatewaySipWssUrl(record.host, 'primary'),
  };
  const endpoints = [primary, record.fallback].filter(Boolean) as GatewayEndpoint[];
  let lastError: unknown = null;
  for (const endpoint of endpoints) {
    const endpointRecord = endpoint.role === 'fallback'
      ? await loadEnrollmentRecord(endpoint.host, extension)
      : record;
    if (!endpointRecord) {
      if (endpoint.role === 'fallback') {
        lastError = new GatewayError('network', 'Local gateway enrollment is unavailable');
        continue;
      }
      throw failClosed('Gateway enrollment record is unavailable');
    }
    // Approval is mutable: revalidate at the selected endpoint before SIP.
    let session: GatewaySession;
    try {
      session = sessionFromRecord(endpointRecord, endpoint, host);
    } catch (error) {
      // A pending/unclaimed primary record must not prevent trying the
      // approved local fallback. A local record without approval is terminal
      // for this attempt.
      if (endpoint.role === 'fallback') throw error;
      lastError = error;
      continue;
    }
    const client = new GatewayClient({ baseUrl: session.apiURL, deviceId: session.deviceId, claimSecret: session.claimSecret });
    try {
      // Endpoint selection is allowed to switch between the cloud and local
      // device identities. The active-session guard is for calls made with the
      // already-selected session, not for claims against candidate endpoints;
      // applying it here made the primary candidate throw 'aborted' before the
      // loader could ever try the local fallback.
      const claim = await client.claim(session.deviceId);
      assertGatewaySessionGeneration(generation);
      if (claim.status !== 'approved' || claim.assignment.extension !== extension.trim()) {
        // Local and cloud records are separate; never overwrite cloud status
        // with a local pending/disabled response.
        await saveEnrollmentRecord({ ...endpointRecord, status: claim.status, assignment: undefined });
        resetGatewaySession();
        throw failClosed('Gateway approval is required for this account');
      }
      session.assignment = claim.assignment;
      activeSession = session;
      return session;
    } catch (error) {
      if (!(error instanceof GatewayError) ||
          (error.kind !== 'network' && (error.status || 0) < 500) ||
          endpoint === endpoints[endpoints.length - 1]) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError || failClosed('Gateway unavailable');
}

/** Returns the persisted record (approved or pending) for login/restore UX. */
export async function getPersistedGatewayRecord(
  host: string,
  extension: string,
): Promise<EnrollmentRecord | null> {
  const record = await loadEnrollmentRecord(host, extension);
  if (record?.gatewayMode) return record;
  if (await isKnownGatewayHost(host)) throw failClosed('This gateway account requires enrollment');
  return null;
}

/**
 * Device-facing gateway signalling URL.
 *
 * `assignment.wsURL` is the **proxy upstream** target — the PBX socket the
 * gateway relays to. It is usually private (tailnet/LAN), so a phone on a
 * mobile network cannot dial it, and a public PBX socket would let the device
 * bypass the gateway's ticket/extension/revocation enforcement entirely. The
 * device must therefore always use the gateway's own public WS endpoint,
 * derived from the host the user configured — the same URL `getSipWss()`
 * builds for the legacy path.
 *
 * @param host        configured server host (scheme/path tolerated)
 * Public enrolled accounts always use WSS, including older saved accounts
 * whose TLS toggle is off. Private/direct-PBX transport policy is unchanged.
 */
export function resolveGatewaySipWebSocketUrl(host: string, fallbackUrl?: string): string {
  const { hostname } = splitHost(host);
  if (!hostname) throw failClosed('Gateway WebSocket URL is not configured');
  if (!isPrivateHost(hostname)) {
    const authority = hostname.includes(':') ? `[${hostname}]` : hostname.toLowerCase();
    const secure = getSipWss(authority, true);
    // Retain caller query parameters only on this exact secure gateway URL.
    return fallbackUrl?.startsWith(`${secure}?`) ? fallbackUrl : secure;
  }
  const derived = fallbackUrl || getSipWss(normalizeServerHost(host), false);
  if (!derived) throw failClosed('Gateway WebSocket URL is not configured');
  return derived;
}

/**
 * WS URL for JsSIP. Every (re)connect mints a new one-use ticket, so a stale or
 * already-consumed ticket is never reused across reconnects.
 */
export async function buildGatewaySipWebSocketUrl(
  session: GatewaySession,
  fallbackUrl?: string,
): Promise<string> {
  const configured = session.sipWssUrl || resolveGatewaySipWebSocketUrl(session.host, fallbackUrl);
  // Preserve caller query parameters only on the same endpoint URL. This keeps
  // transport flags used by the legacy reconnect path while never allowing a
  // different host to replace the selected gateway endpoint.
  const base = fallbackUrl && fallbackUrl.startsWith(`${configured}?`) ? fallbackUrl : configured;
  const client = new GatewayClient({
    baseUrl: session.apiURL,
    deviceId: session.deviceId,
    claimSecret: session.claimSecret,
  });
  const { ticket } = await sessionRequest(session, () => client.sipTicket());
  return appendQuery(base, { ticket });
}

/** TURN credentials from the gateway; relay is mandatory. */
export async function gatewayMediaConfiguration(
  session: GatewaySession,
): Promise<MediaConfiguration> {
  const client = new GatewayClient({
    baseUrl: session.apiURL,
    deviceId: session.deviceId,
    claimSecret: session.claimSecret,
  });
  return sessionRequest(session, () => client.iceServers());
}

/** Tell the gateway this device is alive so its watchdog can skip a wake. */
export async function sendGatewayHeartbeat(
  host: string,
  extension: string,
  sipState: string,
): Promise<boolean> {
  const session = getActiveGatewaySession(host, extension) ||
    await getOrLoadGatewaySession(host, extension);
  if (!session) return false;
  const client = new GatewayClient({
    baseUrl: session.apiURL,
    deviceId: session.deviceId,
    claimSecret: session.claimSecret,
  });
  await sessionRequest(session, () => client.heartbeat({ sipState }));
  return true;
}

/** Send sanitized connection/FCM diagnostics for the active approved device. */
export async function sendGatewayTelemetry(
  host: string,
  extension: string,
  telemetry: Record<string, string>,
): Promise<boolean> {
  const session = getActiveGatewaySession(host, extension) ||
    await getOrLoadGatewaySession(host, extension);
  if (!session) return false;
  const client = new GatewayClient({
    baseUrl: session.apiURL,
    deviceId: session.deviceId,
    claimSecret: session.claimSecret,
  });
  await sessionRequest(session, () => client.heartbeat(telemetry));
  return true;
}

/** Live extension/trunk state used to detect a dropped dongle leg. */
export async function getGatewayCallState(
  host: string,
  extension: string,
  extensionAuth: Record<string, string>,
): Promise<GatewayCallState | null> {
  const session = getActiveGatewaySession(host, extension) ||
    await getOrLoadGatewaySession(host, extension);
  if (!session) return null;
  const client = new GatewayClient({
    baseUrl: session.apiURL,
    deviceId: session.deviceId,
    claimSecret: session.claimSecret,
  });
  return sessionRequest(session, () => client.callState(extensionAuth));
}

/** Authenticated push token registration through the gateway. */
export async function registerGatewayPushToken(
  session: GatewaySession,
  body: Record<string, string>,
): Promise<void> {
  const client = new GatewayClient({
    baseUrl: session.apiURL,
    deviceId: session.deviceId,
    claimSecret: session.claimSecret,
  });
  await sessionRequest(session, () => client.registerDevice(body));
}

/** Authenticated device removal on logout. */
export async function removeGatewayPushToken(
  session: GatewaySession,
  body: Record<string, string>,
): Promise<void> {
  const client = new GatewayClient({
    baseUrl: session.apiURL,
    deviceId: session.deviceId,
    claimSecret: session.claimSecret,
  });
  await client.removeDevice(body);
}
