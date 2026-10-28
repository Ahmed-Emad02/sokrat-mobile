/**
 * Platform CSPRNG access for enrollment credentials.
 *
 * Security policy: only cryptographically secure sources are accepted.
 *   1. WebCrypto `crypto.getRandomValues` when the runtime exposes it.
 *   2. The `SokratSecureRandom` native module
 *      (Android `java.security.SecureRandom`, iOS `SecRandomCopyBytes`).
 *
 * If neither is available the call fails closed — there is deliberately no
 * `Math.random()`/timestamp fallback, because the claim secret becomes a bearer
 * credential the moment an administrator approves the device.
 */
import { NativeModules } from 'react-native';
import { bytesToHex } from '@noble/hashes/utils';
import { GatewayError } from './errors';

export const SECURE_RANDOM_MODULE = 'SokratSecureRandom';
export const CLAIM_SECRET_BYTES = 32;
/** Upper bound mirrored by the native modules (defensive, not a security limit). */
export const MAX_RANDOM_BYTES = 1024;

type WebCryptoLike = {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

export type SecureRandomNativeModule = {
  getRandomHex?: (bytes: number) => Promise<string>;
};

export class SecureRandomUnavailableError extends GatewayError {
  constructor(detail: string) {
    super('fail_closed', `Secure random source unavailable (${detail})`);
    this.name = 'SecureRandomUnavailableError';
  }
}

function webCrypto(): WebCryptoLike | undefined {
  const value = (globalThis as { crypto?: WebCryptoLike }).crypto;
  return value && typeof value.getRandomValues === 'function' ? value : undefined;
}

export function resolveNativeSecureRandom(): SecureRandomNativeModule | null {
  const modules = NativeModules as Record<string, SecureRandomNativeModule | undefined> | undefined;
  const native = modules?.[SECURE_RANDOM_MODULE];
  return native && typeof native.getRandomHex === 'function' ? native : null;
}

function assertLength(bytes: number): void {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_RANDOM_BYTES) {
    throw new SecureRandomUnavailableError(`invalid byte length ${bytes}`);
  }
}

function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
}

/**
 * Return `bytes` secure random bytes as lowercase hex.
 * Throws `SecureRandomUnavailableError` (fail-closed) when no CSPRNG exists.
 */
export async function getSecureRandomHex(bytes: number = CLAIM_SECRET_BYTES): Promise<string> {
  assertLength(bytes);

  const crypto = webCrypto();
  if (crypto?.getRandomValues) {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return bytesToHex(buffer);
  }

  const native = resolveNativeSecureRandom();
  if (!native?.getRandomHex) {
    throw new SecureRandomUnavailableError('no WebCrypto and no native module');
  }

  let value: unknown;
  try {
    value = await native.getRandomHex(bytes);
  } catch (error) {
    throw new SecureRandomUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!isHex(value, bytes)) {
    throw new SecureRandomUnavailableError('native module returned invalid bytes');
  }
  return value;
}
