const InCallManager = require('react-native-incall-manager').default;
const { Platform } = require('react-native');
const { startRingtone, stopRingtone, startOutgoingRingback, stopOutgoingRingback } = require('../src/calls/incall');

describe('outgoing ringback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rings until a terminal call state instead of stopping after 30 seconds', () => {
    startRingtone();
    const expectedUri = Platform.OS === 'android' ? '_BUNDLE_' : '_DEFAULT_';
    expect(InCallManager.startRingtone).toHaveBeenCalledWith(
      expectedUri, [0, 1000, 1000, 1000], 'playback', -1,
    );
    stopRingtone();
    expect(InCallManager.stopRingtone).toHaveBeenCalled();
  });

  test('starts and stops the native ringback explicitly', () => {
    startOutgoingRingback();
    expect(InCallManager.startRingback).toHaveBeenCalledWith('_DTMF_');

    stopOutgoingRingback();
    expect(InCallManager.stopRingback).toHaveBeenCalled();
  });
});
