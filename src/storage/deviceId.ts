/**
 * Stable per-install identifier.
 *
 * The same UUID is used for two things that must agree:
 *  - `deviceUuid` in the push-gateway registration (`POST /api/push/register-device`)
 *  - `instance_id` of the JsSIP User-Agent (GRUU / `+sip.instance` contact param)
 *
 * It lives in its own module (instead of inside `push/pushHandler.ts`) so the
 * SIP layer can read it without pulling in Firebase/VoIP-push modules, which
 * are not available in a headless or non-Firebase build.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const DEVICE_UUID_KEY = '@sokrat/device-uuid';

/** Canonical RFC 4122 UUID (any version/variant accepted, case-insensitive). */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Random v4 UUID without depending on native crypto. */
export function createInstallUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Accept only well-formed UUIDs. Tolerates an `urn:uuid:` prefix and casing so
 * values provisioned by other Sokrat clients keep working.
 */
export function normalizeDeviceUuid(value: string | null | undefined): string {
  if (!value) return '';
  const candidate = String(value).trim().replace(/^urn:uuid:/i, '');
  return UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : '';
}

let deviceUuidPromise: Promise<string> | null = null;

async function loadOrCreateDeviceUuid(): Promise<string> {
  try {
    const stored = normalizeDeviceUuid(await AsyncStorage.getItem(DEVICE_UUID_KEY));
    if (stored) return stored;
  } catch (error) {
    console.warn('[device] failed to read device uuid:', error);
  }
  const created = createInstallUuid();
  try {
    await AsyncStorage.setItem(DEVICE_UUID_KEY, created);
  } catch (error) {
    // A read-only store must not block login, push registration or SIP: the
    // in-memory value below stays stable for the lifetime of this process.
    console.warn('[device] failed to persist device uuid:', error);
  }
  return created;
}

/**
 * Resolve the install UUID exactly once per process (concurrent callers share
 * the same promise, so push registration and SIP registration always see the
 * same value).
 */
export function getDeviceUuid(): Promise<string> {
  if (!deviceUuidPromise) {
    deviceUuidPromise = loadOrCreateDeviceUuid();
  }
  return deviceUuidPromise;
}
