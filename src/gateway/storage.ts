/**
 * Persistence for gateway enrollment.
 *
 * One record per (host, extension) holds the 256-bit claim secret, the
 * gateway-issued device id, the last known approval status and the approved
 * assignment. It must survive restarts and headless push wake-ups.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isClaimSecret, randomHex } from './entropy';
import { failClosed } from './errors';
import type { EnrollmentRecord, EnrollmentStatus, GatewayAssignment } from './types';
import { normalizeServerHost } from './urls';

const RECORD_PREFIX = '@sokrat/gateway/v1';
const hostKey = (host: string): string => `@sokrat/gateway-host/v1/${encodeURIComponent(normalizeServerHost(host))}`;

export async function rememberGatewayHost(host: string): Promise<void> {
  await AsyncStorage.setItem(hostKey(host), '1');
}

/** Host-level memory also protects extensions which have never enrolled. */
export async function isKnownGatewayHost(host: string): Promise<boolean> {
  if (await AsyncStorage.getItem(hostKey(host))) return true;
  // Migrate older per-account records without trusting their cached approval.
  const prefix = `${RECORD_PREFIX}/${encodeURIComponent(normalizeServerHost(host))}/`;
  const keys = await AsyncStorage.getAllKeys?.() ?? [];
  if (!keys.some(key => key.startsWith(prefix))) return false;
  await rememberGatewayHost(host);
  return true;
}

export const enrollmentKey = (host: string, extension: string): string =>
  `${RECORD_PREFIX}/${encodeURIComponent(normalizeServerHost(host))}/${encodeURIComponent(extension.trim())}`;

function isAssignment(value: unknown): value is GatewayAssignment {
  if (!value || typeof value !== 'object') return false;
  const assignment = value as Partial<GatewayAssignment>;
  return typeof assignment.deviceId === 'string' &&
    typeof assignment.extension === 'string' &&
    typeof assignment.wsURL === 'string' &&
    typeof assignment.apiURL === 'string';
}

function normalizeRecord(raw: unknown): EnrollmentRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<EnrollmentRecord>;
  if (!isClaimSecret(value.claimSecret)) return null;
  if (typeof value.extension !== 'string' || typeof value.host !== 'string') return null;
  return {
    host: value.host,
    extension: value.extension,
    claimSecret: value.claimSecret,
    deviceId: typeof value.deviceId === 'string' && value.deviceId ? value.deviceId : undefined,
    deviceUuid: typeof value.deviceUuid === 'string' ? value.deviceUuid : undefined,
    enrollmentUuid: typeof value.enrollmentUuid === 'string' ? value.enrollmentUuid : undefined,
    status: (value.status as EnrollmentStatus | 'unclaimed') || 'unclaimed',
    gatewayMode: value.gatewayMode !== false,
    assignment: isAssignment(value.assignment) ? value.assignment : undefined,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  };
}

export async function loadEnrollmentRecord(
  host: string,
  extension: string,
): Promise<EnrollmentRecord | null> {
  try {
    const encoded = await AsyncStorage.getItem(enrollmentKey(host, extension));
    if (!encoded) return null;
    const record = normalizeRecord(JSON.parse(encoded));
    if (!record || normalizeServerHost(record.host) !== normalizeServerHost(host) || record.extension !== extension.trim()) {
      throw failClosed('Invalid gateway enrollment record');
    }
    return record;
  } catch (error) {
    throw failClosed('Gateway enrollment storage is unavailable');
  }
}

export async function saveEnrollmentRecord(record: EnrollmentRecord): Promise<void> {
  await rememberGatewayHost(record.host);
  await AsyncStorage.setItem(
    enrollmentKey(record.host, record.extension),
    JSON.stringify({ ...record, updatedAt: Date.now() }),
  );
}

export async function clearEnrollmentRecord(host: string, extension: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(enrollmentKey(host, extension));
  } catch (error) {
    console.warn('[gateway] failed to clear enrollment record:', error);
  }
}

/** Reuse this installation's claim when it changes extensions on one gateway. */
export async function findInstallationEnrollment(
  host: string,
  deviceUuid: string,
): Promise<EnrollmentRecord | null> {
  const prefix = `${RECORD_PREFIX}/${encodeURIComponent(normalizeServerHost(host))}/`;
  const keys = await AsyncStorage.getAllKeys?.() ?? [];
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const encoded = await AsyncStorage.getItem(key);
    if (!encoded) continue;
    let record: EnrollmentRecord | null;
    try {
      record = normalizeRecord(JSON.parse(encoded));
    } catch {
      throw failClosed('Gateway enrollment storage is unavailable');
    }
    if (!record || normalizeServerHost(record.host) !== normalizeServerHost(host)) {
      throw failClosed('Invalid gateway enrollment record');
    }
    if ((record.deviceUuid || record.enrollmentUuid) === deviceUuid) return record;
  }
  return null;
}

/**
 * Return the persisted record, creating one with a fresh claim secret when the
 * host+extension has never been enrolled. The secret is the same across
 * re-logins so an admin can approve a device that was already requested.
 */
export async function getOrCreateEnrollmentRecord(
  host: string,
  extension: string,
  deviceUuid?: string,
): Promise<EnrollmentRecord> {
  const existing = await loadEnrollmentRecord(host, extension);
  if (existing) {
    const identity = existing.deviceUuid || existing.enrollmentUuid;
    if (deviceUuid && identity && identity !== deviceUuid) {
      // A restored record from another installation cannot authenticate here.
      const fresh: EnrollmentRecord = {
        host: normalizeServerHost(host), extension: extension.trim(),
        claimSecret: await randomHex(), deviceUuid, status: 'unclaimed',
        gatewayMode: true, updatedAt: Date.now(),
      };
      await saveEnrollmentRecord(fresh);
      return fresh;
    }
    if (existing.status === 'revoked' || existing.status === 'rejected') {
      const fresh: EnrollmentRecord = {
        host: normalizeServerHost(host), extension: extension.trim(),
        claimSecret: await randomHex(), deviceUuid: deviceUuid || identity,
        status: 'unclaimed', gatewayMode: true, updatedAt: Date.now(),
      };
      await saveEnrollmentRecord(fresh);
      return fresh;
    }
    if (deviceUuid && existing.deviceUuid !== deviceUuid) {
      const migrated = { ...existing, deviceUuid, enrollmentUuid: undefined };
      await saveEnrollmentRecord(migrated);
      return migrated;
    }
    return existing;
  }

  const prior = deviceUuid ? await findInstallationEnrollment(host, deviceUuid) : null;
  if (prior) {
    // Rejected/revoked claims are terminal. Start a fresh approval request but
    // keep the hardware installation UUID so token ownership can recover safely.
    const terminal = prior.status === 'revoked' || prior.status === 'rejected';
    const record: EnrollmentRecord = {
      ...prior,
      host: normalizeServerHost(host),
      extension: extension.trim(),
      claimSecret: terminal ? await randomHex() : prior.claimSecret,
      deviceId: terminal ? undefined : prior.deviceId,
      deviceUuid,
      enrollmentUuid: undefined,
      status: terminal ? 'unclaimed' : 'pending',
      gatewayMode: true,
      assignment: undefined,
      updatedAt: Date.now(),
    };
    await saveEnrollmentRecord(record);
    return record;
  }

  const record: EnrollmentRecord = {
    host: normalizeServerHost(host),
    extension: extension.trim(),
    claimSecret: await randomHex(),
    deviceUuid,
    status: 'unclaimed',
    gatewayMode: true,
    updatedAt: Date.now(),
  };
  await saveEnrollmentRecord(record);
  return record;
}
