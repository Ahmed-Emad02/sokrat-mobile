import type { Contact } from '../src/storage/store';
import { nameToT9, searchContacts } from '../src/utils/dialSearch';

const contacts: Contact[] = [
  { id: '1', name: 'John', extension: '101' },
  { id: '2', name: 'Alice', extension: '202' },
  { id: '3', name: 'Sales Line', extension: '*88' },
];

describe('dialpad contact search', () => {
  test('maps names to T9 digits', () => {
    expect(nameToT9('John')).toBe('5646');
    expect(nameToT9('Sales Line')).toBe('725375463');
  });

  test('matches extensions first', () => {
    expect(searchContacts(contacts, '101')[0].name).toBe('John');
    expect(searchContacts(contacts, '*88')[0].name).toBe('Sales Line');
  });

  test('matches names through T9', () => {
    const matches = searchContacts(contacts, '5');
    expect(matches.map((contact) => contact.name)).toEqual(
      expect.arrayContaining(['John', 'Alice']),
    );
    expect(matches[0].name).toBe('John');
  });

  test('returns no matches for unknown digits', () => {
    expect(searchContacts(contacts, '999')).toEqual([]);
  });

  test('ignores empty digit queries', () => {
    expect(searchContacts(contacts, '*')).toEqual([]);
  });
});
