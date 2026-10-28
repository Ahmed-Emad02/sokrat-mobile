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
import { GatewayError } from './errors';
import { createGatewaySession, setActiveGatewaySession } from './session';
import { clearEnrollmentRecord, getOrCreateEnrollmentRecord, saveEnrollmentRecord } from './storage';
import type { EnrollmentRecord, GatewaySession } from './types';
import { gatewayBaseUrl, normalizeServerHost } from './urls';

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

  const baseUrl = gatewayBaseUrl(host);
  const fetcher = options.fetcher;
  const timeoutMs = options.timeoutMs;
  const probe = new GatewayClient({ baseUrl, fetcher, timeoutMs });

  options.onProgress?.({ phase: 'detecting', message: 'Checking server…' });
  const capabilities = await probe.capabilities();

  // No gateway (404/unreachable) or approval disabled → keep direct-PBX login.
  if (!capabilities || !capabilities.deviceApproval) {
    options.onProgress?.({ phase: 'legacy', message: '' });
    return { mode: 'legacy', extension };
  }

  let record: EnrollmentRecord = await getOrCreateEnrollmentRecord(host, extension);
  throwIfAborted(options.signal);

  if (record.assignment && record.deviceId && record.status === 'approved') {
    const session = createGatewaySession(host, record.claimSecret, record.deviceId, record.assignment);
    setActiveGatewaySession(session);
    return { mode: 'gateway', extension: record.assignment.extension || extension, session };
  }

  const deviceUuid = await getDeviceUuid();
  const platform = options.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const deviceName = options.deviceName ?? defaultDeviceName(platform, deviceUuid);
  const appVersion = options.appVersion ?? CONFIG.appVersion;
  const pollIntervalMs = clampWait(options.pollIntervalMs, DEFAULT_CLAIM_POLL_MS);
  let networkBackoffMs = Math.max(pollIntervalMs, 50);
  let expiredReenrolls = 0;

  while (true) {
    throwIfAborted(options.signal);

    if (!record.deviceId) {
      // Enroll failures are terminal for this login attempt (fail closed).
      const enrolled = await probe.enroll({
        claimSecret: record.claimSecret,
        platform,
        deviceUuid,
        extension,
        deviceName,
        appVersion,
      });
      record = {
        ...record,
        deviceId: enrolled.deviceId,
        status: enrolled.status,
        updatedAt: Date.now(),
      };
      await saveEnrollmentRecord(record);
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
      if (claim.status === 'approved') {
        const assignment = claim.assignment;
        const assignedDeviceId = assignment.deviceId || deviceId;
        const assignedExtension = assignment.extension || extension;
        if (assignedExtension !== record.extension) {
          // The gateway may assign a different extension; move the record so a
          // restart hydrates the approved device instead of falling back to the
          // direct PBX path.
          await clearEnrollmentRecord(record.host, record.extension);
          record = { ...record, extension: assignedExtension };
        }
        record = {
          ...record,
          deviceId: assignedDeviceId,
          status: 'approved',
          assignment,
          updatedAt: Date.now(),
        };
        await saveEnrollmentRecord(record);
        const session = createGatewaySession(
          host,
          record.claimSecret,
          assignedDeviceId,
          assignment,
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
      if (!(error instanceof GatewayError)) throw error;

      if (error.kind === 'expired') {
        expiredReenrolls += 1;
        if (expiredReenrolls > MAX_EXPIRED_REENROLLS) throw error;
        // Same claim secret, new enrollment request.
        record = { ...record, deviceId: undefined, status: 'expired', updatedAt: Date.now() };
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

      if (error.kind === 'rejected' || error.kind === 'revoked') {
        record = {
          ...record,
          status: error.kind,
          assignment: undefined,
          updatedAt: Date.now(),
        };
        await saveEnrollmentRecord(record);
      }
      throw error;
    }
  }
}
