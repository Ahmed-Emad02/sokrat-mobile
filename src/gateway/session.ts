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
import type { EnrollmentRecord, GatewayAssignment, GatewaySession } from './types';
import { appendQuery, gatewayBaseUrl, normalizeServerHost } from './urls';

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
): GatewaySession {
  const session: GatewaySession = {
    host: normalizeServerHost(host),
    extension: assignment.extension,
    deviceId,
    claimSecret,
    assignment,
    // Authenticated gateway APIs (ICE, SIP ticket, push registration) are
    // always served by the gateway itself. `assignment.apiURL` is the *PBX*
    // API — usually a private address such as http://100.98.185.86:8080 — and
    // using it as the gateway origin sends authenticated device calls to the
    // wrong server (404/401), so it is deliberately ignored here.
    apiURL: gatewayBaseUrl(host),
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

function sessionFromRecord(record: EnrollmentRecord): GatewaySession {
  if (record.status !== 'approved' || !record.assignment || record.assignment.extension !== record.extension) {
    throw failClosed('Device approval is still pending; direct PBX fallback is disabled');
  }
  if (!record.deviceId) {
    throw failClosed('Enrollment record has no device id');
  }
  return createGatewaySession(record.host, record.claimSecret, record.deviceId, record.assignment);
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

  const session = sessionFromRecord(record);
  // Approval is mutable: a cached assignment is not evidence that its PBX or
  // device is still active. Revalidate before every SIP registration/restore.
  const client = new GatewayClient({ baseUrl: session.apiURL, deviceId: session.deviceId, claimSecret: session.claimSecret });
  const claim = await sessionRequest(session, () => client.claim(session.deviceId));
  assertGatewaySessionGeneration(generation);
  if (claim.status !== 'approved' || claim.assignment.extension !== extension.trim()) {
    await saveEnrollmentRecord({ ...record, status: claim.status, assignment: undefined });
    resetGatewaySession();
    throw failClosed('Gateway approval is required for this account');
  }
  session.assignment = claim.assignment;
  activeSession = session;
  return session;
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
  const base = resolveGatewaySipWebSocketUrl(session.host, fallbackUrl);
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
