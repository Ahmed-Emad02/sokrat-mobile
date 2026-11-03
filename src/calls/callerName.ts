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
  if (!/^[+\d\s().*#-]+$/.test(number)) return '';
  return number.replace(/[\s().-]/g, '').replace(/^00/, '+');
}

/**
 * Canonical comparison form for phone numbers. It intentionally changes only
 * unambiguous local/international variants: +20/0020/20/0 and Arabic digits.
 * Feature codes stay verbatim so *88 and 88 are never conflated.
 */
export function canonicalCallerNumber(value: string): string {
  const normalized = normalizeCallerNumber(value);
  if (!normalized) return '';
  if (/[*#]/.test(normalized)) return normalized;
  const digits = normalized.replace(/\D/g, '');
  if (!digits) return normalized;
  if (normalized.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  // Egyptian local forms: 0XXXXXXXXXX and 1XXXXXXXXX (mobile without leading 0).
  if (digits.startsWith('0') && digits.length >= 10) return `+20${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('1')) return `+20${digits}`;
  return `+${digits}`;
}

export function callerNameFromContacts(number: string, contacts: Contact[]): string {
  const key = canonicalCallerNumber(number);
  if (!key) return 'Unknown';
  const match = contacts.find(contact =>
    canonicalCallerNumber(contact.extension) === key && contact.name.trim());
  return match?.name.trim() || 'Unknown';
}

const PLACEHOLDER_NAME = /^(unknown(?: caller)?|incoming call|outgoing call|anonymous|unavailable|restricted|private(?: number)?|غير معروف|متصل غير معروف|مكالمة واردة)$/i;
const ROUTING_NAME = /^(?:dongle|pjsip|sip|local|macro)(?:[\/:\s_-]|$)|^from-(?:internal|trunk)(?:[\/:\s_-]|$)|^trunk(?:[\/:\s_-]|$)/i;

/** A provider-supplied label is only usable when it is a human name, not a trunk/routing label. */
export function usableProviderName(number: string, name?: string | null): string | null {
  const label = String(name || '').trim();
  const address = String(number || '').trim().replace(/^(?:sips?|tel):/i, '').split('@')[0];
  if (!label || PLACEHOLDER_NAME.test(label) || ROUTING_NAME.test(label)) return null;
  if (label === address) return null;
  if (!/[^\d\s+*#().-]/.test(label)) return null;
  return label;
}

/** Best available provider label, falling back to the normal number display. */
export function providerCallerName(number: string, ...names: Array<string | null | undefined>): string {
  for (const name of names) {
    const usable = usableProviderName(number, name);
    if (usable) return usable;
  }
  return callDisplayName(number);
}
