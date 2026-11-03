import { orderContactsForList } from '../src/contacts/order';

test('favourite contacts are listed first while preserving order within groups', () => {
  const contacts = [
    { id: 'a', name: 'Normal A', extension: '1' },
    { id: 'b', name: 'Favourite B', extension: '2', favorite: true },
    { id: 'c', name: 'Normal C', extension: '3' },
    { id: 'd', name: 'Favourite D', extension: '4', favorite: true },
  ];
  expect(orderContactsForList(contacts).map(c => c.id)).toEqual(['b', 'd', 'a', 'c']);
  expect(contacts.map(c => c.id)).toEqual(['a', 'b', 'c', 'd']);
});
