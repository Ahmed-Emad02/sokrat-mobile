describe('mobile push token lifecycle', () => {
  let push: typeof import('../src/push/pushHandler');
  let getToken: jest.Mock;
  let deleteToken: jest.Mock;
  let register: jest.Mock;
  let remove: jest.Mock;
  let getRecord: jest.Mock;
  let getActive: jest.Mock;
  let onRefresh: (token: string) => void;
  let onState: (state: string) => void;
  let backgroundMessage: (message: unknown) => Promise<void>;
  const session = { assignment: { extension: '201' } };

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    getToken = jest.fn().mockResolvedValue('test-fcm-token');
    deleteToken = jest.fn().mockResolvedValue(undefined);
    register = jest.fn().mockResolvedValue(undefined);
    remove = jest.fn().mockResolvedValue(undefined);
    getRecord = jest.fn().mockResolvedValue(session);
    getActive = jest.fn().mockReturnValue(null);
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' },
      AppState: { addEventListener: (_: string, handler: typeof onState) => { onState = handler; } },
    }));
    jest.doMock('@react-native-firebase/messaging', () => ({
      getMessaging: () => ({}),
      getToken,
      deleteToken,
      setBackgroundMessageHandler: (_: unknown, handler: typeof backgroundMessage) => { backgroundMessage = handler; },
      onMessage: jest.fn(),
      onTokenRefresh: (_: unknown, handler: typeof onRefresh) => { onRefresh = handler; },
    }));
    jest.doMock('../src/gateway/session', () => ({
      getPersistedGatewayRecord: getRecord,
      getOrLoadGatewaySession: jest.fn().mockResolvedValue(session),
      getActiveGatewaySession: getActive,
      registerGatewayPushToken: register,
      removeGatewayPushToken: remove,
    }));
    jest.doMock('../src/storage/deviceId', () => ({
      getDeviceUuid: jest.fn().mockResolvedValue('test-device'),
      UUID_PATTERN: /^[a-f0-9-]{36}$/,
    }));
    jest.doMock('../src/storage/store', () => ({
      StorageService: { getAccount: jest.fn().mockResolvedValue({ extension: '201' }) },
    }));
    const { CONFIG } = require('../src/config');
    CONFIG.sipDomain = 'gateway.example';
    CONFIG.pushGateway = 'http://gateway.example';
    push = require('../src/push/pushHandler');
    push.initPush(jest.fn());
  });

  afterEach(async () => {
    await push.unregisterCurrentDevice();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const settle = async () => { await jest.advanceTimersByTimeAsync(0); };

  it('retries getToken failure without waiting for a token change', async () => {
    getToken.mockRejectedValueOnce(new Error('temporarily offline'));
    push.bindExtension('201');
    await settle();
    expect(register).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('retries authenticated registration failure with the cached token', async () => {
    register.mockRejectedValueOnce(new Error('offline'));
    push.bindExtension('201');
    await settle();
    expect(register).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith(session, expect.objectContaining({
      extension: '201', token: 'test-fcm-token', platform: 'android',
    }));
  });

  it('repairs a token once after a 409 registration conflict', async () => {
    register.mockRejectedValueOnce(Object.assign(new Error('token conflict'), { status: 409 }));
    push.bindExtension('201');
    await settle();
    await jest.advanceTimersByTimeAsync(0);
    await settle();
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith(session, expect.objectContaining({
      extension: '201', token: 'test-fcm-token', platform: 'android',
    }));
  });

  it('waits for approval without falling back to the legacy endpoint', async () => {
    const legacy = jest.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = legacy;
    try {
      getRecord.mockResolvedValueOnce({ assignment: null });
      push.bindExtension('201');
      await settle();
      expect(register).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(register).toHaveBeenCalledTimes(1);
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('registers rotated tokens and rechecks on foreground', async () => {
    push.bindExtension('201');
    await settle();
    onRefresh('rotated-test-token');
    await settle();
    expect(register).toHaveBeenLastCalledWith(session, expect.objectContaining({ token: 'rotated-test-token' }));
    onState('active');
    await settle();
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(deleteToken).not.toHaveBeenCalled();
  });

  it('does not invalidate a healthy token when the app version changes', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    AsyncStorage.getItem.mockResolvedValueOnce('1.0.14');
    push.bindExtension('201');
    await settle();
    await Promise.resolve();
    await settle();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('@sokrat/push-app-version', '1.2.0');
    expect(register).toHaveBeenCalledWith(session, expect.objectContaining({ token: 'test-fcm-token' }));
  });

  it('registers with the active local session before probing the cloud record', async () => {
    const localSession = {
      ...session,
      deviceId: 'local-device',
      apiURL: 'http://192.168.100.50:18080',
      endpointId: 'fallback',
      endpointHost: '192.168.100.50:18080',
    };
    getActive.mockReturnValue(localSession);
    push.bindExtension('201');
    await settle();
    expect(register).toHaveBeenCalledWith(localSession, expect.objectContaining({
      extension: '201', token: 'test-fcm-token', platform: 'android',
    }));
    expect(getRecord).not.toHaveBeenCalled();
  });

  it('manual repair deletes the token, fetches a new one, and registers it', async () => {
    push.bindExtension('201');
    await settle();
    deleteToken.mockClear();
    getToken.mockClear();
    register.mockClear();

    await expect(push.repairPushRegistration()).resolves.toBe(true);
    expect(deleteToken).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(session, expect.objectContaining({
      extension: '201', token: 'test-fcm-token', platform: 'android',
    }));
  });

  it('stops all registration retries on logout', async () => {
    register.mockRejectedValue(new Error('offline'));
    push.bindExtension('201');
    await settle();
    await push.unregisterCurrentDevice();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(register).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not register a token whose account changed during session lookup', async () => {
    let resolveRecord!: (value: unknown) => void;
    getRecord.mockImplementationOnce(() => new Promise((resolve) => { resolveRecord = resolve; }));
    push.bindExtension('201');
    await settle();
    push.bindExtension('');
    resolveRecord(session);
    await settle();
    expect(register).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(register).not.toHaveBeenCalled();
  });

  it('drains in-flight registration before removing the device on logout', async () => {
    let finish!: () => void;
    register.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    push.bindExtension('201');
    await settle();
    const logout = push.unregisterCurrentDevice();
    await settle();
    expect(remove).not.toHaveBeenCalled();
    finish();
    await logout;
    expect(remove).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('replays a headless push once when React mounts instead of deduplicating it away', async () => {
    jest.resetModules();
    push = require('../src/push/pushHandler');
    const callId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await backgroundMessage({ data: {
      msg: 'incoming-call', callId, callerId: '202', extension: '201', timestamp: String(Date.now()),
    } });
    const incoming = jest.fn();
    push.initPush(incoming);
    await settle();
    expect(incoming).toHaveBeenCalledTimes(1);
    expect(incoming).toHaveBeenCalledWith(expect.objectContaining({ callId }));
    push.initPush(incoming);
    await settle();
    expect(incoming).toHaveBeenCalledTimes(1);
  });

  it('drops a delayed push for the previous extension after switching accounts', async () => {
    const incoming = jest.fn();
    push.initPush(incoming);
    await backgroundMessage({ data: {
      msg: 'incoming-call', callId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      callerId: '202', extension: 'old-extension', timestamp: String(Date.now()),
    } });
    await settle();
    expect(incoming).not.toHaveBeenCalled();
  });
});
