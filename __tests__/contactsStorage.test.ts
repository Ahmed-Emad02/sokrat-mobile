import AsyncStorage from '@react-native-async-storage/async-storage';
import { StorageService } from '../src/storage/store';

const CONTACTS_KEY = '@sokrat_contacts';
const SPEED_DIAL_KEY = '@sokrat_speed_dial';
const stored = new Map<string, string>();

beforeEach(() => {
  stored.clear();
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => stored.get(key) ?? null);
  (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
    stored.set(key, value);
  });
});

test('fresh storage does not invent or persist contacts', async () => {
  expect(await StorageService.getContacts()).toEqual([]);
  expect(await StorageService.getContacts()).toEqual([]);
  expect(stored.has(CONTACTS_KEY)).toBe(false);
});

test('existing contacts and favourites survive reads without rewriting stored data', async () => {
  const raw = '[ {"id":"c1","name":"My helpdesk","extension":"101","favorite":true}, {"id":"personal","name":"Colleague","extension":"5072","favorite":false} ]';
  stored.set(CONTACTS_KEY, raw);

  expect(await StorageService.getContacts()).toEqual(JSON.parse(raw));
  expect(stored.get(CONTACTS_KEY)).toBe(raw);
});

test('an explicitly empty contact list stays empty', async () => {
  stored.set(CONTACTS_KEY, '[]');
  expect(await StorageService.getContacts()).toEqual([]);
  expect(stored.get(CONTACTS_KEY)).toBe('[]');
});

test('fresh storage has no assigned speed-dial target', async () => {
  expect(await StorageService.getSpeedDial()).toEqual({});
  expect(stored.has(SPEED_DIAL_KEY)).toBe(false);
});

test('explicit voicemail and custom speed-dial targets survive without rewriting stored data', async () => {
  const raw = '{ "1": "*97", "2": "2401", "7": "5072" }';
  stored.set(SPEED_DIAL_KEY, raw);

  expect(await StorageService.getSpeedDial()).toEqual({ '1': '*97', '2': '2401', '7': '5072' });
  expect(stored.get(SPEED_DIAL_KEY)).toBe(raw);
});

test('an existing map without key 1 does not acquire a voicemail target', async () => {
  stored.set(SPEED_DIAL_KEY, '{"2":"5072"}');
  expect(await StorageService.getSpeedDial()).toEqual({ '2': '5072' });
});

test('clearing key 1 stays cleared after saving and reading again', async () => {
  stored.set(SPEED_DIAL_KEY, '{"1":"*97","2":"2401"}');
  const configured = await StorageService.getSpeedDial();
  delete configured['1'];
  await StorageService.saveSpeedDial(configured);

  expect(await StorageService.getSpeedDial()).toEqual({ '2': '2401' });
  expect(stored.get(SPEED_DIAL_KEY)).toBe('{"2":"2401"}');
});

test('unreadable speed-dial data does not invent a callable target', async () => {
  stored.set(SPEED_DIAL_KEY, '{invalid');
  expect(await StorageService.getSpeedDial()).toEqual({});
  expect(stored.get(SPEED_DIAL_KEY)).toBe('{invalid');
});

test('stored JSON null remains an unassigned speed-dial map', async () => {
  stored.set(SPEED_DIAL_KEY, 'null');
  expect(await StorageService.getSpeedDial()).toEqual({});
  expect(stored.get(SPEED_DIAL_KEY)).toBe('null');
});
