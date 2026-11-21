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

/** Consecutive PBX samples required before the client trusts a "gone" state. */
export const TRUNK_RECONCILE_MISSES = 2;

export type TrunkReconcileSample = { callerActive: boolean; trunkActive: boolean };

export type TrunkReconcileMemory = {
  /** Whether the PBX has ever reported this caller leg. */
  seenCallerActive: boolean;
  /** Consecutive polls with the caller present but the dongle trunk gone. */
  trunkMissing: number;
  /** Consecutive polls with the caller gone after having been seen. */
  callerMissing: number;
};

export const INITIAL_TRUNK_RECONCILE_MEMORY: TrunkReconcileMemory = {
  seenCallerActive: false,
  trunkMissing: 0,
  callerMissing: 0,
};

export type TrunkReconcileDecision =
  | { action: 'none'; memory: TrunkReconcileMemory }
  | { action: 'end'; cause: 'TRUNK_LOST' | 'CALLER_GONE'; memory: TrunkReconcileMemory };

/**
 * Fold one gateway call-state sample into the reconcile state machine.
 *
 * A call is ended when the dongle trunk disappears while the caller leg stays,
 * or when the PBX drops the caller leg entirely after having reported it. The
 * before-first-sample guard keeps a PBX that has not yet observed the call from
 * triggering a false teardown; `null` samples (API errors) are handled by the
 * caller and never end a call.
 */
export function nextTrunkReconcileAction(
  sample: TrunkReconcileSample | null,
  memory: TrunkReconcileMemory,
  misses = TRUNK_RECONCILE_MISSES,
): TrunkReconcileDecision {
  if (!sample) return { action: 'none', memory };
  if (!sample.callerActive) {
    if (!memory.seenCallerActive) {
      return { action: 'none', memory: INITIAL_TRUNK_RECONCILE_MEMORY };
    }
    const callerMissing = memory.callerMissing + 1;
    if (callerMissing >= misses) {
      return { action: 'end', cause: 'CALLER_GONE', memory: INITIAL_TRUNK_RECONCILE_MEMORY };
    }
    return { action: 'none', memory: { ...memory, callerMissing, trunkMissing: 0 } };
  }
  const trunkMissing = sample.trunkActive ? 0 : memory.trunkMissing + 1;
  if (!sample.trunkActive && trunkMissing >= misses) {
    return { action: 'end', cause: 'TRUNK_LOST', memory: INITIAL_TRUNK_RECONCILE_MEMORY };
  }
  return {
    action: 'none',
    memory: { seenCallerActive: true, trunkMissing, callerMissing: 0 },
  };
}
