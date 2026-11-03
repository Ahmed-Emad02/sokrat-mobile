import { resolveCallerName, CONTACTS_PATH } from '../src/calls/callerNameResolver';
import { StorageService } from '../src/storage/store';
import { getOrLoadGatewaySession } from '../src/gateway/session';
import { extensionHeaders } from '../src/network';
import { lookupDeviceContactName } from '../src/calls/nativeCallNotification';

const global = globalThis;

jest.mock('../src/gateway/session', () => ({ getOrLoadGatewaySession: jest.fn() }));
jest.mock('../src/calls/nativeCallNotification', () => ({ lookupDeviceContactName: jest.fn() }));
const account = { serverHost: 'pbx.example', extension: '204', password: 'test-only', useTls: false, dnd: false, autoAnswer: false };
const originalFetch = global.fetch;
beforeEach(() => {
  jest.spyOn(StorageService, 'getContacts').mockResolvedValue([]);
  (lookupDeviceContactName as jest.Mock).mockResolvedValue('');
  (getOrLoadGatewaySession as jest.Mock).mockResolvedValue(null);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ contacts: [{ id: 1, first_name: 'Server', last_name: 'Contact', phone: '+442012345678' }] }) });
});
afterEach(() => { jest.restoreAllMocks(); global.fetch = originalFetch; });

test('device contacts win without reading app contacts or requesting the PBX', async () => {
  (lookupDeviceContactName as jest.Mock).mockResolvedValue('Device Contact');
  expect(await resolveCallerName('01012345678', account)).toBe('Device Contact');
  expect(StorageService.getContacts).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('app contacts win without requesting the PBX', async () => {
  jest.spyOn(StorageService, 'getContacts').mockResolvedValue([{ id: 'a', name: 'App contact', extension: '+44 20 1234 5678' }]);
  expect(await resolveCallerName('00442012345678', account)).toBe('App contact');
  expect(global.fetch).not.toHaveBeenCalled();
});
test('a local miss looks up authenticated server contacts with the exact signed query', async () => {
  expect(await resolveCallerName('+442012345678', account)).toBe('Server Contact');
  const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe(`http://pbx.example:80${CONTACTS_PATH}`);
  expect(options.headers).toMatchObject(extensionHeaders({ ...account, path: CONTACTS_PATH, timestamp: options.headers['X-Sokrat-Timestamp'] }));
});
test('a private PBX uses its API port', async () => {
  await resolveCallerName('+442012345678', { ...account, serverHost: '10.0.0.2' });
  expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`http://10.0.0.2:8080${CONTACTS_PATH}`);
});
test('tenant lookup supplies both approved device headers and PBX signature', async () => {
  (getOrLoadGatewaySession as jest.Mock).mockResolvedValue({ apiURL: 'http://gateway.example', deviceId: 'dev_test', claimSecret: 'fixture-secret' });
  expect(await resolveCallerName('+442012345678', account)).toBe('Server Contact');
  expect(global.fetch).toHaveBeenCalledWith('http://gateway.example/api/gateway/contacts?limit=2000', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-secret', 'X-Sokrat-Device': 'dev_test', 'X-Sokrat-Extension': '204' }) }));
});
test('revoked enrollment never falls back to a direct PBX request', async () => {
  (getOrLoadGatewaySession as jest.Mock).mockRejectedValue(new Error('revoked'));
  expect(await resolveCallerName('+442012345678', account)).toBe('Unknown');
  expect(global.fetch).not.toHaveBeenCalled();
});
test('unmatched numbers, denied access and server failures resolve Unknown', async () => {
  expect(await resolveCallerName('555', account)).toBe('Unknown');
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 });
  expect(await resolveCallerName('555', account)).toBe('Unknown');
  (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
  expect(await resolveCallerName('555', account)).toBe('Unknown');
});
