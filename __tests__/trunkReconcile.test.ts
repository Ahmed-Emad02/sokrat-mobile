import {
  INITIAL_TRUNK_RECONCILE_MEMORY,
  isExternalDestination,
  nextTrunkReconcileAction,
  shouldReconcileTrunk,
} from '../src/calls/trunkReconcile';

describe('dongle trunk reconciliation policy', () => {
  test('leaves internal extensions and feature codes alone', () => {
    for (const target of ['103', '1234', '123456', '*97', '**', '#21', '']) {
      expect(isExternalDestination(target)).toBe(false);
      expect(shouldReconcileTrunk('outbound', target)).toBe(false);
    }
  });

  test('recognizes external numbers in common dialing forms', () => {
    for (const target of [
      '+201012345678',
      '00201012345678',
      '01012345678',
      '201012345678',
      '1234567',
      'tel:+201012345678',
      'sip:+201012345678@pbx.example',
    ]) {
      expect(isExternalDestination(target)).toBe(true);
      expect(shouldReconcileTrunk('outbound', target)).toBe(true);
    }
  });

  test('never reconciles an inbound session', () => {
    expect(shouldReconcileTrunk('inbound', '+201012345678')).toBe(false);
  });
});

describe('dongle trunk reconciliation state machine', () => {
  test('never ends a call before the PBX has reported the caller', () => {
    let memory = INITIAL_TRUNK_RECONCILE_MEMORY;
    for (let i = 0; i < 5; i += 1) {
      const decision = nextTrunkReconcileAction({ callerActive: false, trunkActive: false }, memory);
      expect(decision.action).toBe('none');
      memory = decision.memory;
    }
    expect(memory.seenCallerActive).toBe(false);
  });

  test('ends after two caller-gone samples once the caller was seen', () => {
    const seen = nextTrunkReconcileAction({ callerActive: true, trunkActive: true }, INITIAL_TRUNK_RECONCILE_MEMORY);
    expect(seen.action).toBe('none');
    expect(seen.memory.seenCallerActive).toBe(true);

    const first = nextTrunkReconcileAction({ callerActive: false, trunkActive: false }, seen.memory);
    expect(first.action).toBe('none');
    const second = nextTrunkReconcileAction({ callerActive: false, trunkActive: false }, first.memory);
    expect(second).toMatchObject({ action: 'end', cause: 'CALLER_GONE' });
  });

  test('keeps the existing trunk-gone rule', () => {
    const seen = nextTrunkReconcileAction({ callerActive: true, trunkActive: true }, INITIAL_TRUNK_RECONCILE_MEMORY);
    const first = nextTrunkReconcileAction({ callerActive: true, trunkActive: false }, seen.memory);
    expect(first.action).toBe('none');
    const second = nextTrunkReconcileAction({ callerActive: true, trunkActive: false }, first.memory);
    expect(second).toMatchObject({ action: 'end', cause: 'TRUNK_LOST' });
  });

  test('a trunk sample resets caller-gone misses', () => {
    const seen = nextTrunkReconcileAction({ callerActive: true, trunkActive: true }, INITIAL_TRUNK_RECONCILE_MEMORY);
    const gone = nextTrunkReconcileAction({ callerActive: false, trunkActive: false }, seen.memory);
    const back = nextTrunkReconcileAction({ callerActive: true, trunkActive: true }, gone.memory);
    expect(back.action).toBe('none');
    expect(back.memory.callerMissing).toBe(0);
    const goneAgain = nextTrunkReconcileAction({ callerActive: false, trunkActive: false }, back.memory);
    expect(goneAgain.action).toBe('none');
  });

  test('unknown samples never end the call', () => {
    const seen = nextTrunkReconcileAction({ callerActive: true, trunkActive: true }, INITIAL_TRUNK_RECONCILE_MEMORY);
    for (let i = 0; i < 5; i += 1) {
      const decision = nextTrunkReconcileAction(null, seen.memory);
      expect(decision.action).toBe('none');
      expect(decision.memory).toEqual(seen.memory);
    }
  });
});
