/**
 * Entropy for the enrollment claim secret (256 bit).
 *
 * Delegates to `getSecureRandomHex`, which only accepts a platform CSPRNG
 * (WebCrypto or the native `SokratSecureRandom` bridge backed by
 * `java.security.SecureRandom` / `SecRandomCopyBytes`). There is deliberately
 * no fallback: the claim secret becomes a bearer credential the moment an
 * administrator approves the device, so an insecure source must fail closed.
 */
import { getSecureRandomHex } from './secureRandom';

export { CLAIM_SECRET_BYTES, SecureRandomUnavailableError } from './secureRandom';
export { getSecureRandomHex } from './secureRandom';

/** Random hex string, `bytes` bytes long (default 32 = 256 bit). */
export async function randomHex(bytes?: number): Promise<string> {
  return getSecureRandomHex(bytes);
}

/** True for a persisted 256-bit claim secret (64 lowercase hex characters). */
export function isClaimSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
