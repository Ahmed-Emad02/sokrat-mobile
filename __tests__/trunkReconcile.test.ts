import { isExternalDestination, shouldReconcileTrunk } from '../src/calls/trunkReconcile';

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
