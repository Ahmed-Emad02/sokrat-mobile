/**
 * Gateway signalling routing regression (B1).
 *
 * The approved assignment's `wsURL` is the gateway's **upstream** PBX socket,
 * not the device-facing endpoint. It is frequently private (LAN / tailnet /
 * loopback) and therefore undialable from a mobile network, while a public PBX
 * socket would let the device bypass the gateway's ticket, extension-binding
 * and revocation enforcement. Every SIP connect must therefore dial the
 * gateway's own public WS URL derived from the configured host, with a freshly
 * minted one-use ticket.
 */
import { getSipWss } from '../src/config';
import { GatewayError } from '../src/gateway/errors';
import {
  buildGatewaySipWebSocketUrl,
  createGatewaySession,
  gatewayMediaConfiguration,
  registerGatewayPushToken,
  removeGatewayPushToken,
  resolveGatewaySipWebSocketUrl,
} from '../src/gateway/session';
import type { GatewayAssignment } from '../src/gateway/types';

/** Public host exactly as the user types it in the login screen. */
const HOST = 'gw.sokrat.example';
const PUBLIC_WS = 'ws://gw.sokrat.example:8088/ws';

function assignmentWith(wsURL: string): GatewayAssignment {
  return {
    deviceId: 'dev-1',
    pbxId: 'pbx-1',
    pbxName: 'Sokrat Lab',
    extension: '160',
    wsURL,
    apiURL: `http://${HOST}`,
    mediaIps: ['203.0.113.5'],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = (init.headers || {}) as Record<string, string>;
  return headers[name];
}

type TicketCall = { url: string; init: RequestInit };

/** Installs a fetch stub that mints sequential one-use tickets. */
function stubTicketEndpoint(tickets: string[], calls: TicketCall[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const ticket = tickets.shift();
    if (!ticket) throw new Error(`unexpected extra ticket request to ${url}`);
    return jsonResponse(200, { ticket, expiresIn: 30 });
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('gateway signalling URL derivation', () => {
  test('uses the caller-derived public URL and tolerates scheme/path in the host', () => {
    expect(resolveGatewaySipWebSocketUrl(HOST, PUBLIC_WS)).toBe(PUBLIC_WS);
    expect(resolveGatewaySipWebSocketUrl(`http://${HOST}/login`, PUBLIC_WS)).toBe(PUBLIC_WS);
    expect(resolveGatewaySipWebSocketUrl('GW.Sokrat.Example', PUBLIC_WS)).toBe(PUBLIC_WS);
  });

  test('derives the same public WS endpoint as the legacy transport helper', () => {
    expect(resolveGatewaySipWebSocketUrl(HOST)).toBe(getSipWss(HOST));
    expect(resolveGatewaySipWebSocketUrl(HOST)).toBe(PUBLIC_WS);
  });

  test('fails closed when no gateway host is known', () => {
    expect(() => resolveGatewaySipWebSocketUrl('', '')).toThrow(GatewayError);
    try {
      resolveGatewaySipWebSocketUrl('');
    } catch (error) {
      expect((error as GatewayError).kind).toBe('fail_closed');
    }
  });
});

describe('ticket connections never dial the assignment upstream URL', () => {
  const privateUpstreams = [
    'ws://10.0.0.5:8088/ws',
    'ws://100.98.185.86:8088/ws', // tailnet / CGNAT test bench
    'ws://127.0.0.1:8088/ws',
    'wss://pbx.internal.example:8089/ws',
  ];

  test.each(privateUpstreams)('ignores private upstream %s', async (wsURL) => {
    globalThis.fetch = stubTicketEndpoint(['ticket-a']);
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', assignmentWith(wsURL));

    const url = await buildGatewaySipWebSocketUrl(session, PUBLIC_WS);

    expect(url).toBe(`${PUBLIC_WS}?ticket=ticket-a`);
    expect(url).not.toContain(new URL(wsURL).host);
  });

  test('rotating the upstream assignment between reconnects does not move the device', async () => {
    globalThis.fetch = stubTicketEndpoint(['ticket-1', 'ticket-2']);
    const first = createGatewaySession(HOST, 'secret-1', 'dev-1', assignmentWith('ws://10.0.0.5:8088/ws'));
    const rotated = createGatewaySession(HOST, 'secret-1', 'dev-1', assignmentWith('ws://10.0.0.9:8088/ws'));

    const one = await buildGatewaySipWebSocketUrl(first, PUBLIC_WS);
    const two = await buildGatewaySipWebSocketUrl(rotated, PUBLIC_WS);

    expect(one).toBe(`${PUBLIC_WS}?ticket=ticket-1`);
    expect(two).toBe(`${PUBLIC_WS}?ticket=ticket-2`);
    expect(new URL(one).origin).toBe(new URL(two).origin);
  });

  test('keeps the TLS scheme chosen by the caller', async () => {
    globalThis.fetch = stubTicketEndpoint(['ticket-tls']);
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', assignmentWith('ws://10.0.0.5:8088/ws'));

    await expect(
      buildGatewaySipWebSocketUrl(session, 'wss://gw.sokrat.example:8089/ws'),
    ).resolves.toBe('wss://gw.sokrat.example:8089/ws?ticket=ticket-tls');
  });

  test('preserves existing query parameters when appending the ticket', async () => {
    globalThis.fetch = stubTicketEndpoint(['ticket-q']);
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', assignmentWith('ws://10.0.0.5:8088/ws'));

    await expect(
      buildGatewaySipWebSocketUrl(session, `${PUBLIC_WS}?transport=ws`),
    ).resolves.toBe(`${PUBLIC_WS}?transport=ws&ticket=ticket-q`);
  });
});

describe('ticket freshness across reconnects', () => {
  test('mints a distinct one-use ticket for every connect', async () => {
    const calls: TicketCall[] = [];
    globalThis.fetch = stubTicketEndpoint(['ticket-1', 'ticket-2', 'ticket-3'], calls);
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', assignmentWith('ws://10.0.0.5:8088/ws'));

    const urls: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      urls.push(await buildGatewaySipWebSocketUrl(session, PUBLIC_WS));
    }

    expect(urls).toEqual([
      `${PUBLIC_WS}?ticket=ticket-1`,
      `${PUBLIC_WS}?ticket=ticket-2`,
      `${PUBLIC_WS}?ticket=ticket-3`,
    ]);
    expect(new Set(urls).size).toBe(3);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url).toBe(`http://${HOST}/api/gateway/sip-ticket`);
      expect(call.init.method).toBe('POST');
      expect(headerOf(call.init, 'Authorization')).toBe('Bearer secret-1');
      expect(headerOf(call.init, 'X-Sokrat-Device')).toBe('dev-1');
    }
  });

  test('propagates ticket rejection instead of reusing a stale URL', async () => {
    let issued = 0;
    globalThis.fetch = (async () => {
      issued += 1;
      return jsonResponse(403, { error: 'Device approval required' });
    }) as unknown as typeof fetch;
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', assignmentWith('ws://10.0.0.5:8088/ws'));

    await expect(buildGatewaySipWebSocketUrl(session, PUBLIC_WS)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(issued).toBe(1);
  });
});

describe('gateway API origin', () => {
  /** Live test-bench PBX API: private, and never a valid client origin. */
  const PBX_API = 'http://100.98.185.86:8080';

  function sessionWithPrivatePbxApi(host = HOST) {
    return createGatewaySession(host, 'secret-1', 'dev-1', {
      ...assignmentWith('ws://10.0.0.5:8088/ws'),
      apiURL: PBX_API,
    });
  }

  test('never adopts the PBX apiURL as the gateway origin', () => {
    const session = sessionWithPrivatePbxApi();

    expect(session.apiURL).toBe(`http://${HOST}`);
    expect(session.apiURL).not.toContain('100.98.185.86');
    expect(session.apiURL).not.toBe(PBX_API);
  });

  test('keeps the private-gateway default port', () => {
    expect(sessionWithPrivatePbxApi('192.168.1.5').apiURL).toBe('http://192.168.1.5:8095');
    expect(sessionWithPrivatePbxApi('100.98.185.86').apiURL).toBe('http://100.98.185.86:8095');
  });

  test('honours an explicit port in the configured host', () => {
    expect(sessionWithPrivatePbxApi('gw.sokrat.example:8443').apiURL).toBe(
      'http://gw.sokrat.example:8443',
    );
  });

  test('every authenticated gateway call targets the gateway origin', async () => {
    const calls: TicketCall[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/ice')) {
        return jsonResponse(200, {
          iceServers: [{ urls: 'turn:turn.sokrat.example:3500?transport=udp', username: 'u', credential: 'c' }],
        });
      }
      return jsonResponse(200, { ticket: 'ticket-1', expiresIn: 30 });
    }) as unknown as typeof fetch;

    const session = sessionWithPrivatePbxApi();
    await buildGatewaySipWebSocketUrl(session, PUBLIC_WS);
    await gatewayMediaConfiguration(session);
    await registerGatewayPushToken(session, {
      platform: 'android',
      token: 'fcm-token',
      deviceUuid: '6f1a4d9e-0000-4000-8000-000000000001',
      appVersion: '1.0.0',
    });
    await removeGatewayPushToken(session, {
      platform: 'android',
      deviceUuid: '6f1a4d9e-0000-4000-8000-000000000001',
    });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/gateway/sip-ticket',
      '/api/gateway/ice',
      '/api/gateway/register-device',
      '/api/gateway/remove-device',
    ]);
    for (const call of calls) {
      expect(call.url.startsWith(`http://${HOST}/`)).toBe(true);
      expect(call.url).not.toContain('100.98.185.86:8080');
      expect(headerOf(call.init, 'Authorization')).toBe('Bearer secret-1');
      expect(headerOf(call.init, 'X-Sokrat-Device')).toBe('dev-1');
    }
  });
});
