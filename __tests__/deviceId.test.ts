type AsyncStorageMock = {
  getItem: jest.Mock;
  setItem: jest.Mock;
};

type DeviceIdModule = typeof import('../src/storage/deviceId');

/** Load a fresh copy of the module (and its own AsyncStorage mock instance). */
function loadDeviceIdModule(): { deviceId: DeviceIdModule; storage: AsyncStorageMock } {
  let deviceId!: DeviceIdModule;
  let storage!: AsyncStorageMock;
  jest.isolateModules(() => {
    storage = require('@react-native-async-storage/async-storage');
    deviceId = require('../src/storage/deviceId');
  });
  return { deviceId, storage };
}

describe('device id helpers', () => {
  test('createInstallUuid returns a v4 UUID and validates the pattern', () => {
    const { deviceId } = loadDeviceIdModule();
    for (let i = 0; i < 25; i += 1) {
      const uuid = deviceId.createInstallUuid();
      expect(uuid).toMatch(deviceId.UUID_PATTERN);
      expect(uuid[14]).toBe('4');
      expect('89ab').toContain(uuid[19]);
    }
    expect(deviceId.createInstallUuid()).not.toBe(deviceId.createInstallUuid());
  });

  test('normalizeDeviceUuid accepts urn prefixes and casing, rejects junk', () => {
    const { deviceId } = loadDeviceIdModule();
    const uuid = '8b6d4a1e-1c2f-4a3b-9f10-2d3c4b5a6e7f';
    expect(deviceId.normalizeDeviceUuid(uuid)).toBe(uuid);
    expect(deviceId.normalizeDeviceUuid(`  ${uuid.toUpperCase()}  `)).toBe(uuid);
    expect(deviceId.normalizeDeviceUuid(`urn:uuid:${uuid}`)).toBe(uuid);
    expect(deviceId.normalizeDeviceUuid('not-a-uuid')).toBe('');
    expect(deviceId.normalizeDeviceUuid('')).toBe('');
    expect(deviceId.normalizeDeviceUuid(null)).toBe('');
    expect(deviceId.normalizeDeviceUuid(undefined)).toBe('');
  });

  test('persists one UUID under the shared push registration key', async () => {
    const { deviceId, storage } = loadDeviceIdModule();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      deviceId.getDeviceUuid(),
      deviceId.getDeviceUuid(),
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(deviceId.UUID_PATTERN);
    // Read once, write once: the promise cache prevents duplicate Identity writes.
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem).toHaveBeenCalledWith(deviceId.DEVICE_UUID_KEY);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(deviceId.DEVICE_UUID_KEY, first);
    expect(deviceId.DEVICE_UUID_KEY).toBe('@sokrat/device-uuid');
  });

  test('reuses a stored UUID (same value push registration already sent)', async () => {
    const { deviceId, storage } = loadDeviceIdModule();
    const stored = '1f0c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
    storage.getItem.mockResolvedValue(stored);

    await expect(deviceId.getDeviceUuid()).resolves.toBe(stored);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('replaces a corrupt stored value and survives read/write failures', async () => {
    const first = loadDeviceIdModule();
    first.storage.getItem.mockResolvedValue('corrupt');
    first.storage.setItem.mockResolvedValue(undefined);
    const created = await first.deviceId.getDeviceUuid();
    expect(created).toMatch(first.deviceId.UUID_PATTERN);
    expect(first.storage.setItem).toHaveBeenCalledWith(first.deviceId.DEVICE_UUID_KEY, created);

    const second = loadDeviceIdModule();
    second.storage.getItem.mockRejectedValue(new Error('storage unavailable'));
    second.storage.setItem.mockRejectedValue(new Error('storage read-only'));
    const fallback = await second.deviceId.getDeviceUuid();
    expect(fallback).toMatch(second.deviceId.UUID_PATTERN);
  });
});
