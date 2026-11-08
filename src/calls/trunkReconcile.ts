/** PBX extension API path signed by the appliance and forwarded by the gateway. */
export const TRUNK_STATE_PATH = '/api/extension/v1/call-state';

/**
 * Decide whether an outbound session can be affected by a GSM dongle.
 *
 * Extension dialing and feature codes are internal and must never trigger
 * trunk reconciliation. This is intentionally conservative: a false negative
 * leaves a stale SIP session (the old behaviour), while terminating an
 * internal call would be destructive.
 */
export function isExternalDestination(target: string): boolean {
  const raw = String(target || '').trim().replace(/^(?:sips?|tel):/i, '').split('@')[0];
  if (!raw || /[*#]/.test(raw)) return false;
  if (/^\+/.test(raw)) return true;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return false;
  if (digits.startsWith('00')) return true;
  return digits.length >= 7;
}

export function shouldReconcileTrunk(direction: 'inbound' | 'outbound', target: string): boolean {
  return direction === 'outbound' && isExternalDestination(target);
}
