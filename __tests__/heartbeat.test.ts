describe('heartbeat wake ACK', () => {
  let backgroundMessage: (message: unknown) => Promise<void>;
  let sendHeartbeat: jest.Mock;
  let getAccount: jest.Mock;
  let getOrLoadSession: jest.Mock;
  let startConnectionService: jest.Mock;
  let sip: {
    isRegistered: jest.Mock;
    isConnectedOrConnecting: jest.Mock;
    connect: jest.Mock;
  };

  const account = {
    extension: '201',
    serverHost: 'gateway.example',
    password: 'secret',
    useTls: true,
  };

  const wake = (data: Record<string, string> = {}) =>
    backgroundMessage({
      data: {
        msg: 'wake',
        type: 'keepalive',
        timestamp: '1793540000000',
        ...data,
      },
    });

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    sendHeartbeat = jest.fn().mockResolvedValue(true);
    getAccount = jest.fn().mockResolvedValue(account);
    getOrLoadSession = jest.fn().mockResolvedValue({ assignment: { extension: '201' } });
    startConnectionService = jest.fn();
    sip = {
      isRegistered: jest.fn().mockReturnValue(true),
      isConnectedOrConnecting: jest.fn().mockReturnValue(true),
      connect: jest.fn().mockResolvedValue(undefined),
    };

    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' },
      AppState: { addEventListener: jest.fn() },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: {
        getItem: jest.fn().mockResolvedValue(null),
        setItem: jest.fn().mockResolvedValue(undefined),
        removeItem: jest.fn().mockResolvedValue(undefined),
      },
    }));
    jest.doMock('@react-native-firebase/messaging', () => ({
      getMessaging: () => ({}),
      getToken: jest.fn().mockResolvedValue('token'),
      setBackgroundMessageHandler: (_: unknown, handler: typeof backgroundMessage) => {
        backgroundMessage = handler;
      },
      onMessage: jest.fn(),
      onTokenRefresh: jest.fn(),
      requestPermission: jest.fn(),
    }));
    jest.doMock('../src/gateway/session', () => ({
      getPersistedGatewayRecord: jest.fn(),
      getOrLoadGatewaySession: getOrLoadSession,
      registerGatewayPushToken: jest.fn(),
      removeGatewayPushToken: jest.fn(),
      sendGatewayHeartbeat: sendHeartbeat,
    }));
    jest.doMock('../src/storage/store', () => ({
      StorageService: { getAccount },
    }));
    jest.doMock('../src/storage/deviceId', () => ({
      getDeviceUuid: jest.fn().mockResolvedValue('device-uuid'),
      UUID_PATTERN: /^[a-f0-9-]{36}$/,
    }));
    jest.doMock('../src/calls/connectionService', () => ({
      startConnectionService,
    }));
    jest.doMock('../src/sip/JsSipService', () => ({
      getSharedJsSipService: () => sip,
    }));

    require('../src/push/pushHandler');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ACKs only after SIP is already registered', async () => {
    await wake();

    expect(startConnectionService).toHaveBeenCalledTimes(1);
    expect(sip.connect).not.toHaveBeenCalled();
    expect(sendHeartbeat).toHaveBeenCalledWith('gateway.example', '201', 'wake');
  });

  it('does not ACK while SIP is still connecting and not registered', async () => {
    sip.isRegistered.mockReturnValue(false);
    sip.isConnectedOrConnecting.mockReturnValue(true);

    await wake();

    expect(sip.connect).not.toHaveBeenCalled();
    expect(sendHeartbeat).not.toHaveBeenCalled();
  });

  it('does not ACK when SIP bootstrap fails', async () => {
    sip.isRegistered.mockReturnValue(false);
    sip.isConnectedOrConnecting.mockReturnValue(false);
    sip.connect.mockRejectedValue(new Error('network down'));

    await wake();

    expect(sip.connect).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).not.toHaveBeenCalled();
  });

  it('does not ACK a wake for a different extension', async () => {
    await wake({ extension: '202' });

    expect(startConnectionService).not.toHaveBeenCalled();
    expect(sendHeartbeat).not.toHaveBeenCalled();
  });

  it('does not log success when there is no gateway session', async () => {
    sendHeartbeat.mockResolvedValue(false);

    await wake();

    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('heartbeat ACK sent'),
    );
  });

  it('deduplicates a repeated wake only after a successful ACK', async () => {
    await wake();
    await wake();

    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
  });
});
