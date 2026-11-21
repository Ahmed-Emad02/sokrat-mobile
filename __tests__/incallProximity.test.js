'use strict';
const { NativeModules, Platform, DeviceEventEmitter } = require('react-native');
const InCallManager = require('react-native-incall-manager').default;

describe('in-call proximity screen control', () => {
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

  function loadInCall() {
    let incall;
    jest.isolateModules(() => {
      incall = require('../src/calls/incall');
    });
    return incall;
  }

  function installNativeRouting(selected = 'EARPIECE') {
    NativeModules.CallNotificationModule = {
      setAudioRoute: jest.fn(async () => {}),
      getAvailableAudioRoutes: jest.fn(async () => ({
        availableDevices: ['EARPIECE', 'SPEAKER_PHONE'],
        selectedDevice: selected,
        hasBluetooth: false,
        bluetoothName: '',
      })),
    };
  }

  it('turns the screen off at the ear and back on when moved away', () => {
    installNativeRouting();
    const incall = loadInCall();
    incall.startCallManagers();

    DeviceEventEmitter.emit('Proximity', { isNear: true });
    expect(InCallManager.turnScreenOff).toHaveBeenCalledTimes(1);

    DeviceEventEmitter.emit('Proximity', { isNear: false });
    expect(InCallManager.turnScreenOn).toHaveBeenCalledTimes(1);

    incall.stopCallManagers();
  });

  it('keeps the screen on for speaker and applies proximity again when returning to earpiece', async () => {
    installNativeRouting();
    const incall = loadInCall();
    incall.startCallManagers();
    const unsubscribe = incall.subscribeAudioDeviceChanges(() => {});
    await Promise.resolve();

    DeviceEventEmitter.emit('Proximity', { isNear: true });
    expect(InCallManager.turnScreenOff).toHaveBeenCalledTimes(1);

    DeviceEventEmitter.emit('onSokratAudioDeviceChanged', {
      availableAudioDeviceList: JSON.stringify(['EARPIECE', 'SPEAKER_PHONE']),
      selectedAudioDevice: 'SPEAKER_PHONE',
      hasBluetooth: false,
      bluetoothName: '',
    });
    expect(InCallManager.turnScreenOn).toHaveBeenCalledTimes(1);

    DeviceEventEmitter.emit('onSokratAudioDeviceChanged', {
      availableAudioDeviceList: JSON.stringify(['EARPIECE', 'SPEAKER_PHONE']),
      selectedAudioDevice: 'EARPIECE',
      hasBluetooth: false,
      bluetoothName: '',
    });
    expect(InCallManager.turnScreenOff).toHaveBeenCalledTimes(2);

    unsubscribe();
    incall.stopCallManagers();
  });

  it('stops reacting to the proximity sensor after the call is torn down', () => {
    installNativeRouting();
    const incall = loadInCall();
    incall.startCallManagers();
    incall.stopCallManagers();

    DeviceEventEmitter.emit('Proximity', { isNear: true });
    expect(InCallManager.turnScreenOff).not.toHaveBeenCalled();
  });
});
