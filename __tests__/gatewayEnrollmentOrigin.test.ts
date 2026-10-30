/**
 * Enrollment must keep using the public gateway origin even when the persisted
 * assignment already carries the gateway's upstream PBX API address.
 *
 * `assignment.apiURL` is the PBX behind the proxy (frequently a private
 * LAN/tailnet address). It is never a device-facing endpoint: using it for the
 * claim/ICE/ticket/push calls sends authenticated device traffic to the wrong
 * server and bypasses the gateway's approval enforcement.
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
import { prepareLogin } from '../src/gateway/enrollment';
import { randomHex } from '../src/gateway/entropy';
import { loadEnrollmentRecord, saveEnrollmentRecord } from '../src/gateway/storage';
import { buildGatewaySipWebSocketUrl, getOrLoadGatewaySession, registerGatewayPushToken, resetGatewaySession } from '../src/gateway/session';
import type { GatewayAssignment } from '../src/gateway/types';
import { gatewayBaseUrl } from '../src/gateway/urls';

const HOST = 'gw.sokrat.example';
const PBX_API = 'http://100.98.185.86:8080';
const PBX_WS = 'ws://10.0.0.5:8088/ws';

const ASSIGNMENT: GatewayAssignment = {
  deviceId: 'dev-1',
  pbxId: 'pbx-1',
  pbxName: 'Sokrat Lab',
  extension: '160',
  wsURL: PBX_WS,
  apiURL: PBX_API,
  mediaIps: ['10.0.0.5'],
};

const CAPABILITIES = {
  version: 1,
  deviceApproval: true,
  enrollmentPath: '/api/gateway/enrollment',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('enrollment gateway origin', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetGatewaySession();
  });

  test('a stored assignment apiURL never moves the claim to the PBX', async () => {
    await saveEnrollmentRecord({
      host: HOST,
      extension: '160',
      claimSecret: await randomHex(),
      deviceId: 'dev-1',
      status: 'pending',
      gatewayMode: true,
      assignment: ASSIGNMENT,
      updatedAt: Date.now(),
    });

    const calls: string[] = [];
    const fetcher = jest.fn(async (url: string) => {
      calls.push(url);
      const path = new URL(url).pathname;
      if (path === '/api/gateway/capabilities') return jsonResponse(200, CAPABILITIES);
      if (path === '/api/gateway/enrollment/enroll') return jsonResponse(200, { device: { id: 'dev-1' }, status: 'pending' });
      if (path === '/api/gateway/enrollment/claim') {
        return jsonResponse(200, { status: 'approved', assignment: ASSIGNMENT });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const result = await prepareLogin({
      host: HOST,
      extension: '160',
      pollIntervalMs: 1,
      fetcher,
    });

    expect(result.mode).toBe('gateway');
    if (result.mode !== 'gateway') throw new Error('expected gateway login');
    expect(result.session.apiURL).toBe(gatewayBaseUrl(HOST));
    expect(result.session.apiURL).not.toBe(PBX_API);
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) {
      expect(url.startsWith(gatewayBaseUrl(HOST))).toBe(true);
      expect(url).not.toContain('100.98.185.86');
      expect(url).not.toContain('10.0.0.5');
    }
  });

  test('an existing approved account upgrades HTTPS/WSS without a new identity or approval', async () => {
    const record = {
      host: HOST, extension: '160', claimSecret: await randomHex(),
      deviceId: 'dev-1', deviceUuid: 'existing-installation', status: 'approved' as const,
      gatewayMode: true, assignment: ASSIGNMENT, updatedAt: Date.now(),
    };
    await saveEnrollmentRecord(record);
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = jest.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/claim')) return jsonResponse(200, { status: 'approved', assignment: ASSIGNMENT });
      if (url.endsWith('/sip-ticket')) return jsonResponse(200, { ticket: 'new-ticket', expiresIn: 30 });
      if (url.endsWith('/register-device')) return jsonResponse(200, { success: true });
      throw new Error('Unexpected request');
    }) as unknown as typeof fetch;
    try {
      const session = await getOrLoadGatewaySession(HOST, '160');
      if (!session) throw new Error('Expected enrolled account');
      expect(session.apiURL).toBe(`https://${HOST}`);
      await expect(buildGatewaySipWebSocketUrl(session, `ws://${HOST}:8088/ws`))
        .resolves.toBe(`wss://${HOST}:8089/ws?ticket=new-ticket`);
      await registerGatewayPushToken(session, { platform: 'android', token: 'fixture-fcm', deviceUuid: record.deviceUuid });
      expect(calls).toHaveLength(3);
      expect(calls.every(url => url.startsWith(`https://${HOST}/`))).toBe(true);
      expect(await loadEnrollmentRecord(HOST, '160')).toMatchObject({
        claimSecret: record.claimSecret, deviceId: record.deviceId,
        deviceUuid: record.deviceUuid, status: 'approved',
      });
    } finally { globalThis.fetch = originalFetch; }
  });

  test('TLS failure retains the saved approval and never creates a replacement enrollment', async () => {
    const record = {
      host: HOST, extension: '160', claimSecret: await randomHex(), deviceId: 'dev-1',
      deviceUuid: 'existing-installation', status: 'approved' as const,
      gatewayMode: true, assignment: ASSIGNMENT, updatedAt: Date.now(),
    };
    await saveEnrollmentRecord(record);
    const originalFetch = globalThis.fetch;
    const fetcher = jest.fn(async () => { throw new TypeError('TLS certificate rejected'); });
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      await expect(getOrLoadGatewaySession(HOST, '160')).rejects.toMatchObject({ kind: 'network' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await loadEnrollmentRecord(HOST, '160')).toMatchObject({
        claimSecret: record.claimSecret, deviceId: record.deviceId, status: 'approved',
      });
    } finally { globalThis.fetch = originalFetch; }
  });
});
