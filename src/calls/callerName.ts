import type { Contact } from '../storage/store';

/** Contact/PBX names win; placeholder labels must never hide an available number. */
export function callDisplayName(number: string, name?: string | null): string {
  const label = String(name || '').trim();
  const placeholder = /^(unknown(?: caller)?|incoming call|outgoing call|anonymous|unavailable|restricted|private(?: number)?|غير معروف|متصل غير معروف|مكالمة واردة)$/i;
  if (label && !placeholder.test(label)) return label;
  const address = String(number || '').trim().replace(/^(?:sips?|tel):/i, '').split('@')[0];
  // Preserve formatting, international/Arabic digits and feature codes. Never
  // invent a number for withheld identities or expose a trunk label as a person.
  return /[0-9\u0660-\u0669\u06f0-\u06f9]/.test(address) &&
    /^[+*#0-9\u0660-\u0669\u06f0-\u06f9\s().-]+$/.test(address) ? address : 'Unknown';
}

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
