import { HandoverSocket } from '../src/sip/HandoverSocket';
jest.unmock('jssip');

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  OPEN = 1;
  CONNECTING = 0;
  readyState = 0;
  binaryType = '';
  onopen = () => {};
  onclose = (_event: unknown) => {};
  onmessage = (_event: unknown) => {};
  onerror = (_event: unknown) => {};
  send = jest.fn();
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  close() { this.readyState = 3; this.onclose({ wasClean: true, code: 1000 }); }
  open() { this.readyState = 1; this.onopen(); }
}

describe('HandoverSocket uses JsSIP public Socket contract', () => {
  const originalWebSocket = globalThis.WebSocket;
  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => { globalThis.WebSocket = originalWebSocket; });

  test('retains routing metadata but obtains a fresh URL on every reconnect', async () => {
    const next = jest.fn(async () => 'wss://gateway.example/ws?ticket=new&flow=abc');
    const socket = new HandoverSocket('wss://gateway.example/ws?ticket=initial&flow=abc', next);
    socket.onconnect = jest.fn();
    socket.ondisconnect = jest.fn();
    socket.connect();
    expect(FakeWebSocket.instances[0].url).toContain('ticket=initial');
    FakeWebSocket.instances[0].open();
    expect(socket.send('SIP message')).toBe(true);
    expect(socket.sip_uri).toBe('sip:gateway.example;transport=ws');
    socket.reconnect();
    expect(socket.ondisconnect).toHaveBeenCalledWith(false, 1001, 'Network handover');
    socket.connect();
    await Promise.resolve();
    expect(next).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances[1].url).toContain('ticket=new&flow=abc');
    FakeWebSocket.instances[1].open();
    expect(socket.onconnect).toHaveBeenCalledTimes(2);
    socket.disconnect();
  });

  test('disconnect invalidates a pending ticket request and late socket callbacks', async () => {
    let finish!: (value: string) => void;
    const next = jest.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const socket = new HandoverSocket('wss://gateway.example/ws', next);
    socket.connect();
    const lateOpen = FakeWebSocket.instances[0].onopen;
    socket.onconnect = jest.fn();
    socket.ondisconnect = jest.fn();
    socket.ondata = jest.fn();
    socket.reconnect();
    socket.connect();
    socket.connect();
    expect(next).toHaveBeenCalledTimes(1);
    socket.disconnect();
    finish('wss://gateway.example/ws?ticket=late');
    await Promise.resolve();
    lateOpen();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.onconnect).not.toHaveBeenCalled();
    expect(socket.isConnected()).toBe(false);
  });

  test('ticket errors fail closed and do not leak credentials in disconnect reason', async () => {
    const socket = new HandoverSocket('wss://gateway.example/ws', async () => { throw new Error('secret ticket'); });
    socket.ondisconnect = jest.fn();
    socket.connect();
    socket.reconnect();
    socket.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.ondisconnect).toHaveBeenLastCalledWith(true, 1006, 'Signaling authorization unavailable');
    expect(FakeWebSocket.instances).toHaveLength(1);
    socket.disconnect();
  });

  test('network close signals JsSIP and subsequent connect never reuses consumed ticket', async () => {
    const socket = new HandoverSocket('wss://gateway.example/ws?ticket=used', async () => 'wss://gateway.example/ws?ticket=fresh');
    socket.ondisconnect = jest.fn();
    socket.connect();
    FakeWebSocket.instances[0].readyState = 3;
    FakeWebSocket.instances[0].onclose({ wasClean: false, code: 1006, reason: 'sensitive server reason' });
    socket.connect();
    await Promise.resolve();
    expect(FakeWebSocket.instances[1].url).toContain('ticket=fresh');
    expect(socket.ondisconnect).toHaveBeenCalledWith(true, 1006, 'Signaling socket closed');
    socket.disconnect();
  });

  test('actual JsSIP transport reconnects the adapter without replacing the UA transport', async () => {
    jest.useFakeTimers();
    const Transport = jest.requireActual('jssip/lib/Transport');
    const next = jest.fn(async () => 'wss://gateway.example/ws?ticket=fresh');
    const socket = new HandoverSocket('wss://gateway.example/ws?ticket=initial', next);
    const transport = new Transport([{ socket }], { min_interval: 1, max_interval: 1 });
    transport.onconnecting = jest.fn();
    transport.onconnect = jest.fn();
    transport.ondisconnect = jest.fn();
    try {
      transport.connect();
      FakeWebSocket.instances[0].open();
      expect(transport.isConnected()).toBe(true);
      socket.reconnect();
      expect(transport.isConnected()).toBe(false);
      await jest.advanceTimersByTimeAsync(1000);
      expect(next).toHaveBeenCalledTimes(1);
      FakeWebSocket.instances[1].open();
      expect(transport.isConnected()).toBe(true);
      expect(transport.socket).toBe(socket);
    } finally {
      transport.disconnect();
      jest.useRealTimers();
    }
  });
});

test('patched JsSIP waits for fresh candidates on ICE restart despite previous iceReady', async () => {
  const RTCSession = jest.requireActual('jssip/lib/RTCSession');
  const handlers: Record<string, (event?: unknown) => void> = {};
  const connection = {
    iceGatheringState: 'gathering',
    localDescription: { sdp: 'fresh relay SDP' },
    createOffer: jest.fn(async () => ({ type: 'offer', sdp: 'new ICE credentials' })),
    setLocalDescription: jest.fn(async () => {}),
    addEventListener: (event: string, fn: (event?: unknown) => void) => { handlers[event] = fn; },
    removeEventListener: jest.fn(),
  };
  const context = {
    _connection: connection, _iceReady: true, _rtcReady: true,
    emit: jest.fn((_name, event) => { if (event.ready) event.ready(); }),
  };
  let resolved = false;
  const pending = RTCSession.prototype._createLocalDescription.call(context, 'offer', { iceRestart: true })
    .then(() => { resolved = true; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(connection.createOffer).toHaveBeenCalledWith({ iceRestart: true });
  expect(resolved).toBe(false);
  expect(handlers.icecandidate).toBeDefined();
  handlers.icecandidate({ candidate: { type: 'relay' } });
  await pending;
  expect(resolved).toBe(true);
});
