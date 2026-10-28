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
import { saveEnrollmentRecord } from '../src/gateway/storage';
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
});
