const InCallManager = require('react-native-incall-manager').default;
const Sound = require('react-native-nitro-sound').default;
const { Platform } = require('react-native');
const {
  startRingtone,
  stopRingtone,
  stopOutgoingRingback,
  startOutgoingRingback,
  setIncomingRingtone,
} = require('../src/calls/incall');

const RING_ARGUMENTS = [[0, 1000, 1000, 1000], 'playback', -1];

describe('incoming ringtone', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setIncomingRingtone('device');
  });

  test('rings with the phone ringtone until a terminal call state', () => {
    const previous = Platform.OS;
    try {
      Platform.OS = 'android';
      startRingtone();
      expect(InCallManager.startRingtone).toHaveBeenLastCalledWith('_DEFAULT_', ...RING_ARGUMENTS);
      stopRingtone();
      expect(InCallManager.stopRingtone).toHaveBeenCalled();
    } finally {
      Platform.OS = previous;
    }
  });

  test('plays and stops a picked audio file instead of the phone ringtone', () => {
    const previous = Platform.OS;
    try {
      Platform.OS = 'android';
      setIncomingRingtone('custom', 'file:///data/user/0/com.sokratmobile/files/tone.mp3');
      startRingtone();
      expect(Sound.startPlayer).toHaveBeenLastCalledWith(
        'file:///data/user/0/com.sokratmobile/files/tone.mp3',
      );
      expect(InCallManager.startRingtone).not.toHaveBeenCalled();

      stopRingtone();
      expect(Sound.stopPlayer).toHaveBeenCalled();
      expect(InCallManager.stopRingtone).toHaveBeenCalled();
    } finally {
      Platform.OS = previous;
    }
  });

  test('falls back to the phone ringtone when a custom file is missing', () => {
    const previous = Platform.OS;
    try {
      Platform.OS = 'android';
      setIncomingRingtone('custom');
      startRingtone();
      expect(InCallManager.startRingtone).toHaveBeenLastCalledWith('_DEFAULT_', ...RING_ARGUMENTS);
      expect(Sound.startPlayer).not.toHaveBeenCalled();
    } finally {
      Platform.OS = previous;
    }
  });
});

describe('outgoing ringback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses the bundled ringback on Android and the platform default on iOS', () => {
    const previous = Platform.OS;
    try {
      Platform.OS = 'android';
      startOutgoingRingback();
      expect(InCallManager.startRingback).toHaveBeenLastCalledWith('_BUNDLE_');

      stopOutgoingRingback();
      Platform.OS = 'ios';
      startOutgoingRingback();
      expect(InCallManager.startRingback).toHaveBeenLastCalledWith('_DEFAULT_');
      stopOutgoingRingback();
    } finally {
      Platform.OS = previous;
    }
  });

  test('stops the native ringback explicitly', () => {
    stopOutgoingRingback();
    expect(InCallManager.stopRingback).toHaveBeenCalled();
  });
});
