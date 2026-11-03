import type { Contact } from '../storage/store';

/** Keep favourite contacts first without disturbing the caller's chosen order. */
export function orderContactsForList(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
}
