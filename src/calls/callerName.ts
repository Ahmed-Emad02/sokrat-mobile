import type { Contact } from '../storage/store';

/** Compare complete numbers, never short suffixes that can identify the wrong caller. */
export function normalizeCallerNumber(value: string): string {
  const number = String(value || '').trim().replace(/^sips?:/i, '').split('@')[0]
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
  if (!/^[+\d\s().-]+$/.test(number)) return '';
  return number.replace(/[\s().-]/g, '').replace(/^00/, '+');
}

export function callerNameFromContacts(number: string, contacts: Contact[]): string {
  const key = normalizeCallerNumber(number);
  if (!key) return 'Unknown';
  const match = contacts.find(contact =>
    normalizeCallerNumber(contact.extension) === key && contact.name.trim());
  return match?.name.trim() || 'Unknown';
}
