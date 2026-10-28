/**
 * Persistence for gateway enrollment.
 *
 * One record per (host, extension) holds the 256-bit claim secret, the
 * gateway-issued device id, the last known approval status and the approved
 * assignment. It must survive restarts and headless push wake-ups.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isClaimSecret, randomHex } from './entropy';
import type { EnrollmentRecord, EnrollmentStatus, GatewayAssignment } from './types';
import { normalizeServerHost } from './urls';

const RECORD_PREFIX = '@sokrat/gateway/v1';

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
    return normalizeRecord(JSON.parse(encoded));
  } catch (error) {
    console.warn('[gateway] failed to read enrollment record:', error);
    return null;
  }
}

export async function saveEnrollmentRecord(record: EnrollmentRecord): Promise<void> {
  try {
    await AsyncStorage.setItem(
      enrollmentKey(record.host, record.extension),
      JSON.stringify({ ...record, updatedAt: Date.now() }),
    );
  } catch (error) {
    console.warn('[gateway] failed to persist enrollment record:', error);
  }
}

export async function clearEnrollmentRecord(host: string, extension: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(enrollmentKey(host, extension));
  } catch (error) {
    console.warn('[gateway] failed to clear enrollment record:', error);
  }
}

/**
 * Return the persisted record, creating one with a fresh claim secret when the
 * host+extension has never been enrolled. The secret is the same across
 * re-logins so an admin can approve a device that was already requested.
 */
export async function getOrCreateEnrollmentRecord(
  host: string,
  extension: string,
): Promise<EnrollmentRecord> {
  const existing = await loadEnrollmentRecord(host, extension);
  if (existing) return existing;

  const record: EnrollmentRecord = {
    host: normalizeServerHost(host),
    extension: extension.trim(),
    claimSecret: await randomHex(),
    status: 'unclaimed',
    gatewayMode: true,
    updatedAt: Date.now(),
  };
  await saveEnrollmentRecord(record);
  return record;
}
