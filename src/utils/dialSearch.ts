import type { Contact } from '../storage/store';

const T9: Record<string, string> = {
  a: '2', b: '2', c: '2',
  d: '3', e: '3', f: '3',
  g: '4', h: '4', i: '4',
  j: '5', k: '5', l: '5',
  m: '6', n: '6', o: '6',
  p: '7', q: '7', r: '7', s: '7',
  t: '8', u: '8', v: '8',
  w: '9', x: '9', y: '9', z: '9',
};

/** Converts a contact name to its T9 digit sequence (letters only). */
export function nameToT9(name: string): string {
  return (name || '')
    .toLowerCase()
    .split('')
    .map((char) => T9[char] ?? (/[0-9]/.test(char) ? char : ''))
    .join('');
}

/**
 * Live dialpad search. Numeric extensions match directly; names match through
 * their T9 digit sequence so typing "5" finds John/Alice/Liam as well.
 */
export function searchContacts(contacts: Contact[], rawQuery: string): Contact[] {
  const query = (rawQuery || '').replace(/\D/g, '');
  if (!query) return [];

  const literal = (rawQuery || '').trim().toLowerCase();
  const scored = contacts
    .map((contact) => {
      const extension = (contact.extension || '').replace(/\D/g, '');
      const t9 = nameToT9(contact.name);
      const name = (contact.name || '').toLowerCase();

      let score = -1;
      if (extension.startsWith(query)) score = 0;
      else if (t9.startsWith(query)) score = 1;
      else if (extension.includes(query)) score = 2;
      else if (t9.includes(query)) score = 3;
      else if (literal.length > 0 && name.includes(literal)) score = 4;

      return { contact, score };
    })
    .filter((entry) => entry.score >= 0);

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.contact.name.localeCompare(b.contact.name),
  );

  return scored.map((entry) => entry.contact);
}
