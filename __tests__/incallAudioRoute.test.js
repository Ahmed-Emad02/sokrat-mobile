'use strict';
const { NativeModules, Platform, DeviceEventEmitter } = require('react-native');
const InCallManager = require('react-native-incall-manager').default;

describe('Android in-call audio route selection', () => {
  const originalOS = Platform.OS;
  let originalNative;

  beforeEach(() => {
    originalNative = NativeModules.CallNotificationModule;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
    if (originalNative === undefined) delete NativeModules.CallNotificationModule;
    else NativeModules.CallNotificationModule = originalNative;
    jest.clearAllMocks();
  });

  it('uses only the native communication route and serializes rapid switches', async () => {
    let selected = 'EARPIECE';
    const setAudioRoute = jest.fn(async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      selected = route;
    });
    NativeModules.CallNotificationModule = {
      setAudioRoute,
      getAvailableAudioRoutes: jest.fn(async () => ({
        availableDevices: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'],
        selectedDevice: selected,
        hasBluetooth: true,
        bluetoothName: 'Test headset',
      })),
    };

    let incall;
    jest.isolateModules(() => {
      incall = require('../src/calls/incall');
    });
    InCallManager.start.mockClear();
    InCallManager.chooseAudioRoute.mockClear();
    InCallManager.setSpeakerphoneOn.mockClear();
    InCallManager.setForceSpeakerphoneOn.mockClear();
    incall.startCallManagers();
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio', auto: false });
    expect(InCallManager.setForceSpeakerphoneOn).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      incall.chooseAudioRoute('BLUETOOTH'),
      incall.chooseAudioRoute('SPEAKER_PHONE'),
    ]);

    expect(setAudioRoute.mock.calls.map(([route]) => route)).toEqual([
      'BLUETOOTH',
      'SPEAKER_PHONE',
    ]);
    expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
    expect(InCallManager.setSpeakerphoneOn).not.toHaveBeenCalled();
    expect(first.selectedDevice).toBe('BLUETOOTH');
    expect(second.selectedDevice).toBe('SPEAKER_PHONE');
    incall.stopCallManagers();
  });

  it('does not auto-apply native headset connect/disconnect transitions', async () => {
    const setAudioRoute = jest.fn(async () => {});
    NativeModules.CallNotificationModule = {
      setAudioRoute,
      getAvailableAudioRoutes: jest.fn(async () => ({
        availableDevices: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'],
        selectedDevice: 'EARPIECE',
        hasBluetooth: false,
        bluetoothName: '',
      })),
    };

    let incall;
    jest.isolateModules(() => {
      incall = require('../src/calls/incall');
    });
    incall.startCallManagers();
    InCallManager.chooseAudioRoute.mockClear();
    const states = [];
    const unsubscribe = incall.subscribeAudioDeviceChanges((state) => states.push(state));
    await Promise.resolve();

    DeviceEventEmitter.emit('onSokratAudioDeviceChanged', {
      availableAudioDeviceList: JSON.stringify(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']),
      selectedAudioDevice: 'BLUETOOTH',
      hasBluetooth: true,
      bluetoothName: 'Test headset',
    });
    expect(states.at(-1)?.selectedDevice).toBe('BLUETOOTH');

    DeviceEventEmitter.emit('onSokratAudioDeviceChanged', {
      availableAudioDeviceList: JSON.stringify(['EARPIECE', 'SPEAKER_PHONE']),
      selectedAudioDevice: 'EARPIECE',
      hasBluetooth: false,
      bluetoothName: '',
    });
    expect(states.at(-1)?.selectedDevice).toBe('EARPIECE');

    expect(setAudioRoute).not.toHaveBeenCalled();
    expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
    unsubscribe();
    incall.stopCallManagers();
  });

  it('stops Bluetooth retries when the call is torn down', async () => {
    jest.useFakeTimers();
    let selected = 'EARPIECE';
    const setAudioRoute = jest.fn(async () => {
      selected = 'EARPIECE';
    });
    NativeModules.CallNotificationModule = {
      setAudioRoute,
      getAvailableAudioRoutes: jest.fn(async () => ({
        availableDevices: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'],
        selectedDevice: selected,
        hasBluetooth: true,
        bluetoothName: 'Test headset',
      })),
    };

    let incall;
    jest.isolateModules(() => {
      incall = require('../src/calls/incall');
    });
    incall.startCallManagers();
    const pending = incall.chooseAudioRoute('BLUETOOTH');
    while (setAudioRoute.mock.calls.length === 0) await Promise.resolve();
    incall.stopCallManagers();
    jest.advanceTimersByTime(2000);
    await pending;

    expect(setAudioRoute).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
