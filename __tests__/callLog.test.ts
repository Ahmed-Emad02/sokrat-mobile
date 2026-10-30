import type { CallRecord, Contact } from '../src/storage/store';
import {
  buildCallerProfile,
  formatCallDuration,
  groupCallsByDay,
  normalizeNumber,
  nameCallRecords,
} from '../src/utils/callLog';

function record(partial: Partial<CallRecord> & Pick<CallRecord, 'id' | 'number' | 'timestamp'>): CallRecord {
  return {
    name: partial.number,
    direction: 'outbound',
    ...partial,
  };
}

const contacts: Contact[] = [
  { id: 'c1', name: 'Sales Line', extension: '102', favorite: true },
];

describe('call log helpers', () => {
  test('existing recents use current saved contact names without changing numbers', () => {
    const calls = [record({ id: 'old', number: '00442012345678', name: 'dongle0', timestamp: 1000 })];
    const saved = [{ id: 'customer', name: 'Customer', extension: '+44 20 1234 5678' }];
    expect(nameCallRecords(calls, saved)[0]).toMatchObject({ name: 'Customer', number: '00442012345678' });
    expect(calls[0].name).toBe('dongle0');
    expect(nameCallRecords(calls, [{ ...saved[0], name: 'Renamed customer' }])[0].name).toBe('Renamed customer');
  });

  test('recents retain resolved PBX names when no app contact matches', () => {
    const calls = [record({ id: 'server', number: '204', name: 'PBX colleague', timestamp: 1000 })];
    expect(nameCallRecords(calls, [])[0].name).toBe('PBX colleague');
  });
  test('old Unknown recents display their original number without rewriting history', () => {
    const calls = [record({ id: 'unknown', number: '*43', name: 'Unknown', timestamp: 1000 })];
    expect(nameCallRecords(calls, [])[0]).toMatchObject({ name: '*43', number: '*43' });
    expect(calls[0].name).toBe('Unknown');
    expect(buildCallerProfile('*43', calls, []).displayName).toBe('*43');
  });
  test('profile skips placeholder history labels to retain a previously resolved PBX name', () => {
    const calls = [
      record({ id: 'new', number: '204', name: 'Unknown', timestamp: 2000 }),
      record({ id: 'old', number: '204', name: 'PBX colleague', timestamp: 1000 }),
    ];
    expect(buildCallerProfile('204', calls, []).displayName).toBe('PBX colleague');
  });
  test('normalizes separators without changing feature codes', () => {
    expect(normalizeNumber(' 0106 512-1791 ')).toBe('01065121791');
    expect(normalizeNumber('*43')).toBe('*43');
    expect(normalizeNumber('+20 (106) 512-1791')).toBe('+201065121791');
  });

  test('builds an aggregated caller profile', () => {
    const calls: CallRecord[] = [
      record({ id: 'a', number: '102', name: 'Sales Line', timestamp: 3000 }),
      record({ id: 'b', number: '102', direction: 'missed', timestamp: 2000 }),
      record({ id: 'c', number: '102', timestamp: 1000 }),
      record({ id: 'd', number: '101', timestamp: 4000 }),
    ];

    const profile = buildCallerProfile('102', calls, contacts);
    expect(profile.contact?.name).toBe('Sales Line');
    expect(profile.displayName).toBe('Sales Line');
    expect(profile.calls.map((call) => call.id)).toEqual(['a', 'b', 'c']);
    expect(profile.missedCount).toBe(1);
    expect(profile.lastCallAt).toBe(3000);
    expect(profile.isExtension).toBe(true);
  });

  test('falls back to the number for unknown callers', () => {
    const calls: CallRecord[] = [
      record({ id: 'a', number: '01065121791', name: '01065121791', timestamp: 1000 }),
    ];
    const profile = buildCallerProfile('01065121791', calls, contacts);
    expect(profile.contact).toBeNull();
    expect(profile.displayName).toBe('01065121791');
    expect(profile.isExtension).toBe(false);
  });

  test('groups calls into today, yesterday and older dates', () => {
    const now = new Date(2026, 9, 23, 12, 0, 0).getTime();
    const calls: CallRecord[] = [
      record({ id: 'today', number: '101', timestamp: new Date(2026, 9, 23, 9, 0).getTime() }),
      record({ id: 'yesterday', number: '101', timestamp: new Date(2026, 9, 22, 20, 0).getTime() }),
      record({ id: 'older', number: '101', timestamp: new Date(2026, 9, 20, 18, 0).getTime() }),
    ];

    const sections = groupCallsByDay(calls, now);
    expect(sections.map((section) => section.kind)).toEqual(['today', 'yesterday', 'date']);
    expect(sections[0].data.map((call) => call.id)).toEqual(['today']);
    expect(sections[1].data.map((call) => call.id)).toEqual(['yesterday']);
    expect(sections[2].label).toBe('20/10/2026');
  });

  test('formats durations', () => {
    expect(formatCallDuration(5)).toBe('00:05');
    expect(formatCallDuration(65)).toBe('01:05');
    expect(formatCallDuration(3661)).toBe('1:01:01');
  });
});
