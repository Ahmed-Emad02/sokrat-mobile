import type { CallRecord, Contact } from '../storage/store';
import { callDisplayName, callerNameFromContacts, normalizeCallerNumber } from '../calls/callerName';

/** Resolve at display time so saving/renaming a contact also fixes older recents. */
export function nameCallRecords(records: CallRecord[], contacts: Contact[]): CallRecord[] {
  return records.map(record => {
    const localName = callerNameFromContacts(record.number, contacts);
    const name = callDisplayName(record.number, localName === 'Unknown' ? record.name : localName);
    return name === record.name ? record : { ...record, name };
  });
}

export type CallerProfile = {
  number: string;
  normalizedNumber: string;
  contact: Contact | null;
  displayName: string;
  isExtension: boolean;
  calls: CallRecord[];
  missedCount: number;
  lastCallAt: number | null;
};

export type CallLogSectionKind = 'today' | 'yesterday' | 'date';

export type CallLogSection = {
  key: string;
  kind: CallLogSectionKind;
  label: string;
  data: CallRecord[];
};

/**
 * Comparison-only normalization. Display always uses the original value so
 * extensions/feature codes such as *43 and *97 remain readable.
 */
export function normalizeNumber(raw: string): string {
  return normalizeCallerNumber(raw) || (raw || '').trim().replace(/[\s\-().]/g, '');
}

export function isExtensionLike(raw: string): boolean {
  const value = (raw || '').trim();
  return /^\d{1,5}$/.test(value);
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

export function buildCallerProfile(
  number: string,
  calls: CallRecord[],
  contacts: Contact[],
): CallerProfile {
  const normalizedNumber = normalizeNumber(number);
  const contact =
    contacts.find((item) => normalizeNumber(item.extension) === normalizedNumber) ?? null;

  const matching = calls
    .filter((record) => normalizeNumber(record.number) === normalizedNumber)
    .sort((a, b) => b.timestamp - a.timestamp);

  const recordName = matching
    .map((record) => record.name?.trim())
    .find((name) => callDisplayName('', name) !== 'Unknown' && name !== number) ?? '';

  const displayName = callDisplayName(number, contact?.name?.trim() || recordName);

  return {
    number,
    normalizedNumber,
    contact,
    displayName,
    isExtension: isExtensionLike(number),
    calls: matching,
    missedCount: matching.filter((record) => record.direction === 'missed').length,
    lastCallAt: matching[0]?.timestamp ?? null,
  };
}

export function groupCallsByDay(
  records: CallRecord[],
  now: number = Date.now(),
): CallLogSection[] {
  const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
  const todayStart = startOfDay(now);
  const yesterdayDate = new Date(todayStart);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayStart = yesterdayDate.getTime();
  const sections = new Map<string, CallLogSection>();

  for (const record of sorted) {
    const dayStart = startOfDay(record.timestamp);
    const date = new Date(record.timestamp);
    const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

    let section = sections.get(key);
    if (!section) {
      const kind: CallLogSectionKind =
        dayStart === todayStart ? 'today' : dayStart === yesterdayStart ? 'yesterday' : 'date';
      section = {
        key,
        kind,
        label:
          kind === 'date'
            ? `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`
            : '',
        data: [],
      };
      sections.set(key, section);
    }
    section.data.push(record);
  }

  return Array.from(sections.values());
}

export function formatTimeOfDay(timestamp: number): string {
  const date = new Date(timestamp);
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours %= 12;
  if (hours === 0) hours = 12;
  return `${hours}:${pad2(minutes)} ${ampm}`;
}

export function formatCallDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(secs)}`;
  }
  return `${pad2(minutes)}:${pad2(secs)}`;
}
