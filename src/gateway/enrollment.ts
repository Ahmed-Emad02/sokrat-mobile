/**
 * Login-time device enrollment against the gateway.
 *
 * Flow: capability probe → reuse an approved assignment → otherwise enroll
 * (claim secret + stable device UUID) and poll `claim` every 3 s until an
 * administrator approves. Gateway deployments are fail-closed: once detected,
 * no direct-PBX bypass is attempted at any point.
 */
import { Platform } from 'react-native';
import { CONFIG } from '../config';
import { getDeviceUuid } from '../storage/deviceId';
import { DEFAULT_BUSY_RETRY_MS, DEFAULT_CLAIM_POLL_MS, GatewayClient } from './client';
import { GatewayError, failClosed } from './errors';
import { assertGatewaySessionGeneration, createGatewaySession, getGatewaySessionGeneration, resetGatewaySession, setActiveGatewaySession } from './session';
import { getOrCreateEnrollmentRecord, isKnownGatewayHost, loadEnrollmentRecord, rememberGatewayHost, saveEnrollmentRecord } from './storage';
import type { EnrollmentRecord, GatewaySession, GatewayEndpoint } from './types';
import { fallbackGatewayEndpoint, gatewayBaseUrl, normalizeServerHost } from './urls';

export const PENDING_APPROVAL_MESSAGE = 'Waiting for administrator approval…';
export const MAX_NETWORK_BACKOFF_MS = 30_000;
const MAX_EXPIRED_REENROLLS = 3;

export type EnrollmentPhase = 'detecting' | 'pending' | 'waiting' | 'approved' | 'legacy';

export type EnrollmentProgress = {
  phase: EnrollmentPhase;
  message: string;
  retryAfterMs?: number;
};

export type LoginPreparation =
  | { mode: 'legacy'; extension: string }
  | { mode: 'gateway'; extension: string; session: GatewaySession };

export type PrepareLoginOptions = {
  host: string;
  extension: string;
  /** Optional LAN/local gateway origin used only after the primary is unreachable. */
  fallbackHost?: string;
  /** Passed through for callers/tests; SIP auth stays local, never sent to the gateway. */
  password?: string;
  platform?: 'android' | 'ios';
  deviceName?: string;
  appVersion?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: EnrollmentProgress) => void;
};

export function defaultDeviceName(platform: 'android' | 'ios', deviceUuid: string): string {
  const model = (Platform.constants as { Model?: string } | undefined)?.Model;
  const suffix = (model || platform).replace(/\s+/g, ' ').trim();
  return `Sokrat ${suffix} ${deviceUuid.slice(0, 8)}`;
}

function abortError(): GatewayError {
  return new GatewayError('aborted', 'Device enrollment was cancelled');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Abortable sleep used by the approval poll. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort);
  });
}

function clampWait(value: number | undefined, fallback: number): number {
  const ms = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return Math.min(Math.max(ms, 0), 60_000);
}

/**
 * Detect the gateway and, when it requires device approval, complete enrollment
 * before the caller stores the account / starts SIP.
 */
export async function prepareLogin(options: PrepareLoginOptions): Promise<LoginPreparation> {
  const host = normalizeServerHost(options.host);
  if (!host) throw new GatewayError('invalid', 'Server host is not configured');
  const extension = options.extension.trim();
  if (!extension) throw new GatewayError('invalid', 'Extension is not configured');
  resetGatewaySession();
  const generation = getGatewaySessionGeneration();
  const checkCurrent = () => {
    throwIfAborted(options.signal);
    assertGatewaySessionGeneration(generation);
  };
  checkCurrent();
  const existing = await loadEnrollmentRecord(host, extension);
  const knownGateway = existing?.gatewayMode || await isKnownGatewayHost(host);
  checkCurrent();

  const fetcher = options.fetcher;
  const timeoutMs = options.timeoutMs;
  const fallback = options.fallbackHost
    ? fallbackGatewayEndpoint(options.fallbackHost)
    : existing?.fallback;
  const primaryBaseUrl = gatewayBaseUrl(host);
  let baseUrl = primaryBaseUrl;
  let probe = new GatewayClient({ baseUrl, fetcher, timeoutMs });
  let selectedEndpoint: GatewayEndpoint | undefined;

  options.onProgress?.({ phase: 'detecting', message: 'Checking server…' });
  let capabilities = null;
  let primaryError: unknown = null;
  try {
    capabilities = await probe.capabilities();
  } catch (error) {
    primaryError = error;
  }
  checkCurrent();

  // If the cloud/public gateway is unreachable, try the configured LAN gateway
  // with the same claim secret. Authorization failures are not failover cases.
  if ((!capabilities || !capabilities.deviceApproval) && fallback &&
      (!primaryError || (primaryError instanceof GatewayError &&
        (primaryError.kind === 'network' || (primaryError.status || 0) >= 500)))) {
    const fallbackProbe = new GatewayClient({ baseUrl: fallback.apiURL, fetcher, timeoutMs });
    try {
      const fallbackCapabilities = await fallbackProbe.capabilities();
      if (fallbackCapabilities?.deviceApproval) {
        capabilities = fallbackCapabilities;
        baseUrl = fallback.apiURL;
        probe = fallbackProbe;
        selectedEndpoint = fallback;
      }
    } catch {
      // Keep the original primary error / result below.
    }
    checkCurrent();
  }

  // No gateway (404/unreachable) or approval disabled → keep direct-PBX login.
  if (!capabilities || !capabilities.deviceApproval) {
    if (primaryError) throw primaryError;
    if (knownGateway) throw failClosed('Known gateway cannot be bypassed');
    options.onProgress?.({ phase: 'legacy', message: '' });
    return { mode: 'legacy', extension };
  }
  await rememberGatewayHost(host);
  checkCurrent();

  const deviceUuid = await getDeviceUuid();
  checkCurrent();
  let record: EnrollmentRecord = await getOrCreateEnrollmentRecord(host, extension, deviceUuid);
  checkCurrent();
  if (fallback && JSON.stringify(record.fallback) !== JSON.stringify(fallback)) {
    record = { ...record, fallback, updatedAt: Date.now() };
    await saveEnrollmentRecord(record);
    checkCurrent();
  }
  const platform = options.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const deviceName = options.deviceName ?? defaultDeviceName(platform, deviceUuid);
  const appVersion = options.appVersion ?? CONFIG.appVersion;
  const pollIntervalMs = clampWait(options.pollIntervalMs, DEFAULT_CLAIM_POLL_MS);
  let networkBackoffMs = Math.max(pollIntervalMs, 50);
  let expiredReenrolls = 0;
  let enrollmentRequested = false;

  while (true) {
    checkCurrent();

    // Only unclaimed/pending records need an enroll mutation. A changed
    // extension is migrated to pending by storage, so it reaches this path and
    // the gateway revokes the previous authorization before awaiting approval.
    if (!enrollmentRequested && (!record.deviceId || record.status === 'pending' || record.status === 'unclaimed' || record.status === 'expired')) {
      const enrolled = await probe.enroll({
        claimSecret: record.claimSecret,
        platform,
        deviceUuid,
        extension,
        deviceName,
        appVersion,
      });
      checkCurrent();
      record = {
        ...record,
        deviceId: enrolled.deviceId,
        status: enrolled.status,
        updatedAt: Date.now(),
      };
      await saveEnrollmentRecord(record);
      checkCurrent();
      enrollmentRequested = true;
    }

    const deviceId = record.deviceId;
    if (!deviceId) throw new GatewayError('invalid', 'Enrollment did not return a device id');

    const tenant = new GatewayClient({
      // The claim poll is always served by the gateway origin. A stored
      // assignment API URL points at the PBX (often a private address) and must
      // never be used for authenticated gateway calls.
      baseUrl,
      claimSecret: record.claimSecret,
      deviceId,
      fetcher,
      timeoutMs,
    });

    try {
      const claim = await tenant.claim(deviceId);
      checkCurrent();
      if (claim.status === 'approved') {
        const assignment = claim.assignment;
        const assignedDeviceId = assignment.deviceId || deviceId;
        const assignedExtension = assignment.extension || extension;
        if (assignedExtension !== record.extension) {
          throw failClosed('Gateway assignment does not match the requested account');
        }
        record = {
          ...record,
          deviceId: assignedDeviceId,
          status: 'approved',
          assignment,
          updatedAt: Date.now(),
        };
        await saveEnrollmentRecord(record);
        checkCurrent();
        const session = createGatewaySession(
          host,
          record.claimSecret,
          assignedDeviceId,
          assignment,
          selectedEndpoint,
        );
        setActiveGatewaySession(session);
        options.onProgress?.({ phase: 'approved', message: 'Device approved' });
        return { mode: 'gateway', extension: assignedExtension, session };
      }

      if (claim.status === 'pbx_disabled') {
        const waitMs = clampWait(claim.retryAfterMs, DEFAULT_BUSY_RETRY_MS);
        options.onProgress?.({
          phase: 'waiting',
          message: 'The PBX is disabled for this account. Waiting for the administrator…',
          retryAfterMs: waitMs,
        });
        await delay(waitMs, options.signal);
        continue;
      }

      const waitMs = clampWait(claim.retryAfterMs, pollIntervalMs);
      options.onProgress?.({ phase: 'pending', message: PENDING_APPROVAL_MESSAGE, retryAfterMs: waitMs });
      await delay(waitMs, options.signal);
      networkBackoffMs = Math.max(pollIntervalMs, 50);
    } catch (error) {
      checkCurrent();
      if (!(error instanceof GatewayError)) throw error;

      if (error.kind === 'expired') {
        expiredReenrolls += 1;
        if (expiredReenrolls > MAX_EXPIRED_REENROLLS) throw error;
        // Same claim secret, new enrollment request.
        record = { ...record, deviceId: undefined, assignment: undefined, status: 'expired', updatedAt: Date.now() };
        enrollmentRequested = false;
        await saveEnrollmentRecord(record);
        options.onProgress?.({ phase: 'pending', message: 'Enrollment expired. Re-requesting approval…' });
        continue;
      }

      if (error.kind === 'pbx_disabled') {
        const waitMs = clampWait(error.retryAfterMs, DEFAULT_BUSY_RETRY_MS);
        options.onProgress?.({
          phase: 'waiting',
          message: 'The PBX is disabled for this account. Waiting for the administrator…',
          retryAfterMs: waitMs,
        });
        await delay(waitMs, options.signal);
        continue;
      }

      if (error.kind === 'network' && record.deviceId) {
        // Already enrolled: keep the request alive through transient outages.
        options.onProgress?.({
          phase: 'waiting',
          message: 'Waiting for the gateway…',
          retryAfterMs: networkBackoffMs,
        });
        await delay(networkBackoffMs, options.signal);
        networkBackoffMs = Math.min(networkBackoffMs * 2, MAX_NETWORK_BACKOFF_MS);
        continue;
      }

      if (error.kind === 'rejected' || error.kind === 'revoked' || error.kind === 'unauthorized') {
        record = {
          ...record,
          status: error.kind === 'unauthorized' ? 'revoked' : error.kind,
          assignment: undefined,
          updatedAt: Date.now(),
        };
        await saveEnrollmentRecord(record);
      }
      throw error;
    }
  }
}
