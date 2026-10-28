/**
 * Gateway device-enrollment: capability detection, fail-closed behaviour,
 * claim-secret persistence, approval polling, ticket refresh and authenticated
 * tenant APIs.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { GatewayClient } from '../src/gateway/client';
import { GatewayError } from '../src/gateway/errors';
import { PENDING_APPROVAL_MESSAGE, prepareLogin } from '../src/gateway/enrollment';
import { randomHex, isClaimSecret } from '../src/gateway/entropy';
import {
  buildGatewaySipWebSocketUrl,
  createGatewaySession,
  gatewayMediaConfiguration,
  getOrLoadGatewaySession,
  registerGatewayPushToken,
  removeGatewayPushToken,
  resetGatewaySession,
} from '../src/gateway/session';
import { loadEnrollmentRecord, saveEnrollmentRecord } from '../src/gateway/storage';
import type { GatewayAssignment } from '../src/gateway/types';
import {
  appendQuery,
  gatewayAuthHeaders,
  gatewayBaseUrl,
  normalizeServerHost,
} from '../src/gateway/urls';

const HOST = 'pbx.example.com';

const ASSIGNMENT: GatewayAssignment = {
  deviceId: 'dev-1',
  pbxId: 'pbx-1',
  pbxName: 'Sokrat Lab',
  extension: '160',
  wsURL: 'ws://pbx.example.com:8088/ws',
  // The PBX API is a private address on purpose: it must never become the
  // client's gateway origin (see gatewayRouting.test.ts).
  apiURL: 'http://100.98.185.86:8080',
  mediaIps: ['203.0.113.5'],
};

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = (init.headers || {}) as Record<string, string>;
  return headers[name] ?? headers[name.toLowerCase()];
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body || '{}'));
}

const CAPABILITIES = {
  version: 1,
  deviceApproval: true,
  enrollmentPath: '/api/gateway/enrollment',
};

describe('gateway urls + entropy', () => {
  test('gateway base URL follows the public/private port policy', () => {
    expect(gatewayBaseUrl('pbx.example.com')).toBe('http://pbx.example.com');
    expect(gatewayBaseUrl('192.168.1.5')).toBe('http://192.168.1.5:8095');
    expect(gatewayBaseUrl('100.98.185.86')).toBe('http://100.98.185.86:8095');
    expect(gatewayBaseUrl('pbx.example.com:8443')).toBe('http://pbx.example.com:8443');
    expect(normalizeServerHost('https://PBX.Example.com/path')).toBe('pbx.example.com');
  });

  test('appendQuery preserves existing query strings', () => {
    expect(appendQuery('ws://h:8088/ws', { ticket: 'a b' })).toBe('ws://h:8088/ws?ticket=a%20b');
    expect(appendQuery('ws://h:8088/ws?x=1', { ticket: 't' })).toBe('ws://h:8088/ws?x=1&ticket=t');
    expect(appendQuery('ws://h/ws', {})).toBe('ws://h/ws');
  });

  test('auth headers carry the device id and claim secret', () => {
    expect(gatewayAuthHeaders({ claimSecret: 's', deviceId: 'd', json: true })).toEqual({
      Authorization: 'Bearer s',
      'X-Sokrat-Device': 'd',
      'Content-Type': 'application/json',
    });
  });

  test('claim secrets are 256-bit hex and differ per call', async () => {
    const first = await randomHex();
    const second = await randomHex();
    expect(isClaimSecret(first)).toBe(true);
    expect(isClaimSecret(second)).toBe(true);
    expect(first).toHaveLength(64);
    expect(first).not.toBe(second);
  });
});

describe('gateway capability detection', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetGatewaySession();
  });

  test('404 means no gateway: direct PBX login is kept', async () => {
    const fetcher = jest.fn(async () => jsonResponse(404, {})) as unknown as typeof fetch;
    const result = await prepareLogin({ host: HOST, extension: '160', fetcher });
    expect(result).toEqual({ mode: 'legacy', extension: '160' });
  });

  test('unreachable gateway keeps direct PBX login', async () => {
    const fetcher = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const result = await prepareLogin({ host: HOST, extension: '160', fetcher });
    expect(result).toEqual({ mode: 'legacy', extension: '160' });
  });

  test('a detected but broken gateway fails closed (no direct bypass)', async () => {
    const fetcher = jest.fn(async () => jsonResponse(503, {})) as unknown as typeof fetch;
    await expect(prepareLogin({ host: HOST, extension: '160', fetcher })).rejects.toMatchObject({
      kind: 'fail_closed',
      status: 503,
    });
  });

  test('deviceApproval false keeps legacy login', async () => {
    const fetcher = jest.fn(async () =>
      jsonResponse(200, { ...CAPABILITIES, deviceApproval: false }),
    ) as unknown as typeof fetch;
    const result = await prepareLogin({ host: HOST, extension: '160', fetcher });
    expect(result.mode).toBe('legacy');
  });
});

describe('gateway enrollment', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetGatewaySession();
  });

  test('enrolls, polls pending, stores the approved assignment and reuses it', async () => {
    const calls: FetchCall[] = [];
    let claims = 0;
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const path = pathOf(url);
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      if (path === '/api/gateway/enrollment/enroll') {
        return jsonResponse(201, { device: { id: 'dev-1' }, status: 'pending', retryAfterMs: 1 });
      }
      if (path === '/api/gateway/enrollment/claim') {
        claims += 1;
        if (claims === 1) return jsonResponse(202, { status: 'pending', retryAfterMs: 1 });
        return jsonResponse(200, { status: 'approved', assignment: ASSIGNMENT });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const progress: string[] = [];
    const result = await prepareLogin({
      host: HOST,
      extension: '160',
      platform: 'android',
      deviceName: 'Pixel Test',
      appVersion: '9.9.9',
      pollIntervalMs: 1,
      fetcher,
      onProgress: (update) => progress.push(update.message),
    });

    expect(result.mode).toBe('gateway');
    if (result.mode !== 'gateway') throw new Error('expected gateway login');
    expect(result.extension).toBe('160');
    expect(result.session.assignment).toEqual(ASSIGNMENT);
    expect(result.session.apiURL).toBe(gatewayBaseUrl(HOST));
    expect(result.session.apiURL).not.toBe(ASSIGNMENT.apiURL);
    expect(progress).toContain(PENDING_APPROVAL_MESSAGE);
    expect(progress).toContain('Device approved');

    const enrollCall = calls.find((call) => call.url.endsWith('/enrollment/enroll'));
    expect(enrollCall).toBeDefined();
    const enrollBody = bodyOf(enrollCall!.init);
    expect(enrollBody).toMatchObject({
      platform: 'android',
      extension: '160',
      deviceName: 'Pixel Test',
      appVersion: '9.9.9',
    });
    expect(enrollBody.claimSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(enrollBody.deviceUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const claimCalls = calls.filter((call) => call.url.endsWith('/enrollment/claim'));
    expect(claimCalls).toHaveLength(2);
    for (const claim of claimCalls) {
      expect(headerOf(claim.init, 'Authorization')).toBe(`Bearer ${String(enrollBody.claimSecret)}`);
      expect(headerOf(claim.init, 'X-Sokrat-Device')).toBe('dev-1');
      expect(bodyOf(claim.init)).toMatchObject({
        deviceId: 'dev-1',
        claimSecret: enrollBody.claimSecret,
      });
    }

    const record = await loadEnrollmentRecord(HOST, '160');
    expect(record).toMatchObject({ status: 'approved', deviceId: 'dev-1', gatewayMode: true });
    expect(record?.claimSecret).toBe(enrollBody.claimSecret);
    expect(record?.assignment).toEqual(ASSIGNMENT);

    // Next login reuses the approved assignment: no extra enroll/claim.
    const again = await prepareLogin({ host: HOST, extension: '160', pollIntervalMs: 1, fetcher });
    expect(again.mode).toBe('gateway');
    expect(claims).toBe(2);
    expect(calls.filter((call) => call.url.endsWith('/enrollment/enroll'))).toHaveLength(1);
  });

  test('403 rejected is terminal, persisted and fail-closed', async () => {
    const fetcher = jest.fn(async (url: string, _init: RequestInit) => {
      const path = pathOf(url);
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      if (path === '/api/gateway/enrollment/enroll') {
        return jsonResponse(201, { device: { id: 'dev-1' }, status: 'pending' });
      }
      if (path === '/api/gateway/enrollment/claim') {
        return jsonResponse(403, { status: 'rejected' });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      prepareLogin({ host: HOST, extension: '160', fetcher, pollIntervalMs: 1 }),
    ).rejects.toMatchObject({ kind: 'rejected' });

    const record = await loadEnrollmentRecord(HOST, '160');
    expect(record?.status).toBe('rejected');
    await expect(getOrLoadGatewaySession(HOST, '160')).rejects.toMatchObject({
      kind: 'rejected',
    });
  });

  test('410 expired re-enrolls with the same claim secret', async () => {
    const secrets: string[] = [];
    let enrolled = 0;
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      const path = pathOf(url);
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      if (path === '/api/gateway/enrollment/enroll') {
        enrolled += 1;
        secrets.push(String(bodyOf(init).claimSecret));
        return jsonResponse(201, { device: { id: `dev-${enrolled}` }, status: 'pending' });
      }
      if (path === '/api/gateway/enrollment/claim') {
        const { deviceId } = bodyOf(init);
        if (deviceId === 'dev-1') return jsonResponse(410, { status: 'expired' });
        return jsonResponse(200, { status: 'approved', assignment: ASSIGNMENT });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const result = await prepareLogin({
      host: HOST,
      extension: '160',
      fetcher,
      pollIntervalMs: 1,
    });
    expect(result.mode).toBe('gateway');
    expect(enrolled).toBe(2);
    expect(secrets[0]).toBe(secrets[1]);
    expect(isClaimSecret(secrets[0])).toBe(true);
  });

  test('an assigned extension becomes the persisted identity for restarts', async () => {
    const assignment: GatewayAssignment = { ...ASSIGNMENT, extension: '161' };
    const fetcher = jest.fn(async (url: string) => {
      const path = pathOf(url);
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      if (path === '/api/gateway/enrollment/enroll') {
        return jsonResponse(201, { device: { id: 'dev-1' }, status: 'pending' });
      }
      if (path === '/api/gateway/enrollment/claim') {
        return jsonResponse(200, { status: 'approved', assignment });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const result = await prepareLogin({
      host: HOST,
      extension: '160',
      fetcher,
      pollIntervalMs: 1,
    });
    expect(result.mode).toBe('gateway');
    expect(result.extension).toBe('161');

    // The old key no longer exists; a restart hydrates the assigned extension
    // instead of bypassing the gateway as a legacy host.
    expect(await loadEnrollmentRecord(HOST, '160')).toBeNull();
    const record = await loadEnrollmentRecord(HOST, '161');
    expect(record).toMatchObject({ status: 'approved', extension: '161', deviceId: 'dev-1' });
    resetGatewaySession();
    const session = await getOrLoadGatewaySession(HOST, '161');
    expect(session?.extension).toBe('161');
  });

  test('409 pbx_disabled waits for the administrator instead of failing', async () => {
    let claims = 0;
    const fetcher = jest.fn(async (url: string) => {
      const path = pathOf(url);
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      if (path === '/api/gateway/enrollment/enroll') {
        return jsonResponse(201, { device: { id: 'dev-1' }, status: 'pending' });
      }
      if (path === '/api/gateway/enrollment/claim') {
        claims += 1;
        if (claims === 1) return jsonResponse(409, { status: 'pbx_disabled', retryAfterMs: 1 });
        return jsonResponse(200, { status: 'approved', assignment: ASSIGNMENT });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const phases: string[] = [];
    const result = await prepareLogin({
      host: HOST,
      extension: '160',
      fetcher,
      pollIntervalMs: 1,
      onProgress: (update) => phases.push(update.phase),
    });
    expect(result.mode).toBe('gateway');
    expect(phases).toContain('waiting');
    expect(claims).toBe(2);
  });

  test('unreachable enrollment fails closed instead of falling back', async () => {
    let calls = 0;
    const fetcher = jest.fn(async (url: string) => {
      const path = pathOf(url);
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      calls += 1;
      throw new TypeError('dial tcp: no route to host');
    }) as unknown as typeof fetch;

    await expect(
      prepareLogin({ host: HOST, extension: '160', fetcher, pollIntervalMs: 1 }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(calls).toBe(1);
  });

  test('recovers from a transient network error while waiting for approval', async () => {
    let claims = 0;
    const fetcher = jest.fn(async (url: string) => {
      const path = pathOf(url);
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      if (path === '/api/gateway/enrollment/enroll') {
        return jsonResponse(201, { device: { id: 'dev-1' }, status: 'pending' });
      }
      if (path === '/api/gateway/enrollment/claim') {
        claims += 1;
        if (claims === 1) return jsonResponse(202, { status: 'pending', retryAfterMs: 1 });
        if (claims === 2) throw new TypeError('Network request failed');
        return jsonResponse(200, { status: 'approved', assignment: ASSIGNMENT });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const phases: string[] = [];
    const result = await prepareLogin({
      host: HOST,
      extension: '160',
      fetcher,
      pollIntervalMs: 1,
      onProgress: (update) => phases.push(update.phase),
    });
    expect(result.mode).toBe('gateway');
    expect(phases).toContain('waiting');
    expect(claims).toBe(3);
  });

  test('aborted enrollment stops polling', async () => {
    const controller = new AbortController();
    const fetcher = jest.fn(async (url: string) => {
      const path = pathOf(url);
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      if (path === '/api/gateway/enrollment/enroll') {
        return jsonResponse(201, { device: { id: 'dev-1' }, status: 'pending' });
      }
      if (path === '/api/gateway/enrollment/claim') {
        controller.abort();
        return jsonResponse(202, { status: 'pending', retryAfterMs: 5 });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      prepareLogin({
        host: HOST,
        extension: '160',
        fetcher,
        pollIntervalMs: 5,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('gateway session + tenant APIs', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await AsyncStorage.clear();
    resetGatewaySession();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('pending records are fail-closed; approved records hydrate a session', async () => {
    await saveEnrollmentRecord({
      host: HOST,
      extension: '160',
      claimSecret: await randomHex(),
      status: 'pending',
      gatewayMode: true,
      updatedAt: Date.now(),
    });
    await expect(getOrLoadGatewaySession(HOST, '160')).rejects.toMatchObject({
      kind: 'fail_closed',
    });

    const secret = await randomHex();
    await saveEnrollmentRecord({
      host: HOST,
      extension: '160',
      claimSecret: secret,
      deviceId: 'dev-1',
      status: 'approved',
      gatewayMode: true,
      assignment: ASSIGNMENT,
      updatedAt: Date.now(),
    });
    const session = await getOrLoadGatewaySession(HOST, '160');
    expect(session).toMatchObject({
      deviceId: 'dev-1',
      claimSecret: secret,
      extension: '160',
      apiURL: gatewayBaseUrl(HOST),
    });

    // Other hosts stay on the direct PBX path.
    await expect(getOrLoadGatewaySession('other.example.com', '160')).resolves.toBeNull();
  });

  test('every signalling reconnect mints a fresh one-use ticket', async () => {
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', ASSIGNMENT);
    let issued = 0;
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://pbx.example.com/api/gateway/sip-ticket');
      expect(init.method).toBe('POST');
      expect(headerOf(init, 'Authorization')).toBe('Bearer secret-1');
      expect(headerOf(init, 'X-Sokrat-Device')).toBe('dev-1');
      issued += 1;
      return jsonResponse(200, { ticket: `ticket-${issued}`, expiresIn: 30 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetcher;

    // The assignment's wsURL is the gateway's upstream PBX socket and must
    // never be dialed by the device; the gateway-derived URL is used instead.
    await expect(
      buildGatewaySipWebSocketUrl(session, 'ws://gw.example.com:8088/ws'),
    ).resolves.toBe('ws://gw.example.com:8088/ws?ticket=ticket-1');
    await expect(
      buildGatewaySipWebSocketUrl(session, 'ws://gw.example.com:8088/ws'),
    ).resolves.toBe('ws://gw.example.com:8088/ws?ticket=ticket-2');
    expect(issued).toBe(2);
  });

  test('relay credentials force relay and use authenticated gateway ICE', async () => {
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', ASSIGNMENT);
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://pbx.example.com/api/gateway/ice');
      expect(headerOf(init, 'Authorization')).toBe('Bearer secret-1');
      expect(headerOf(init, 'X-Sokrat-Device')).toBe('dev-1');
      return jsonResponse(200, {
        iceServers: [
          {
            urls: ['turn:turn.example.com:3478?transport=udp', 'turn:turn.example.com:3478?transport=tcp'],
            username: 'u',
            credential: 'c',
          },
        ],
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetcher;

    const media = await gatewayMediaConfiguration(session);
    expect(media.iceTransportPolicy).toBe('relay');
    expect(media.iceServers).toHaveLength(1);
    const urls = (media.iceServers[0] as { urls?: string[] | string }).urls;
    expect(Array.isArray(urls) ? urls : [urls]).toHaveLength(2);
  });

  test('empty relay credentials fail the call configuration', async () => {
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', ASSIGNMENT);
    globalThis.fetch = jest.fn(async () =>
      jsonResponse(200, { iceServers: [] }),
    ) as unknown as typeof fetch;

    await expect(gatewayMediaConfiguration(session)).rejects.toBeInstanceOf(GatewayError);
  });

  test('push token registration uses the assignment extension and device auth', async () => {
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', ASSIGNMENT);
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://pbx.example.com/api/gateway/register-device');
      expect(headerOf(init, 'Authorization')).toBe('Bearer secret-1');
      expect(headerOf(init, 'X-Sokrat-Device')).toBe('dev-1');
      expect(bodyOf(init)).toMatchObject({
        extension: '160',
        platform: 'android',
        token: 'fcm-token',
        deviceUuid: 'device-uuid',
      });
      return jsonResponse(201, { success: true });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetcher;

    await registerGatewayPushToken(session, {
      extension: session.assignment.extension,
      platform: 'android',
      token: 'fcm-token',
      deviceUuid: 'device-uuid',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('logout removal hits the authenticated gateway endpoint', async () => {
    const session = createGatewaySession(HOST, 'secret-1', 'dev-1', ASSIGNMENT);
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://pbx.example.com/api/gateway/remove-device');
      expect(headerOf(init, 'Authorization')).toBe('Bearer secret-1');
      expect(bodyOf(init)).toMatchObject({ deviceUuid: 'device-uuid' });
      return jsonResponse(204, null);
    }) as unknown as typeof fetch;
    globalThis.fetch = fetcher;

    await removeGatewayPushToken(session, {
      extension: '160',
      platform: 'android',
      deviceUuid: 'device-uuid',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('tenant APIs without a claim secret are rejected locally', async () => {
    const client = new GatewayClient({ baseUrl: 'http://pbx.example.com' });
    await expect(client.sipTicket()).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
