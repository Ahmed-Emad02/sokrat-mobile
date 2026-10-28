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
import type { MediaConfiguration } from '../network';
import { getSipWss } from '../config';
import { GatewayClient } from './client';
import { GatewayError, failClosed } from './errors';
import { loadEnrollmentRecord } from './storage';
import type { EnrollmentRecord, GatewayAssignment, GatewaySession } from './types';
import { appendQuery, gatewayBaseUrl, normalizeServerHost } from './urls';

let activeSession: GatewaySession | null = null;

export function createGatewaySession(
  host: string,
  claimSecret: string,
  deviceId: string,
  assignment: GatewayAssignment,
): GatewaySession {
  return {
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
}

export function setActiveGatewaySession(session: GatewaySession | null): void {
  activeSession = session;
}

export function resetGatewaySession(): void {
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
  if (!record.assignment) {
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
  const cached = getActiveGatewaySession(host, extension);
  if (cached) return cached;

  const record = await loadEnrollmentRecord(host, extension);
  if (!record || !record.gatewayMode) return null;
  if (record.status === 'rejected' || record.status === 'revoked') {
    throw new GatewayError(record.status, 'Device enrollment is no longer valid');
  }

  const session = sessionFromRecord(record);
  activeSession = session;
  return session;
}

/** Returns the persisted record (approved or pending) for login/restore UX. */
export async function getPersistedGatewayRecord(
  host: string,
  extension: string,
): Promise<EnrollmentRecord | null> {
  const record = await loadEnrollmentRecord(host, extension);
  return record?.gatewayMode ? record : null;
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
 * @param fallbackUrl URL already derived by the caller from that host; wins
 *                    over the local derivation so the caller keeps control of
 *                    the transport scheme (ws vs wss).
 */
export function resolveGatewaySipWebSocketUrl(host: string, fallbackUrl?: string): string {
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
  const { ticket } = await client.sipTicket();
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
  return client.iceServers();
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
  await client.registerDevice(body);
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
