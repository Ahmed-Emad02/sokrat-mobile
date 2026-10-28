import { callerNameFromContacts } from '../src/calls/callerName';

const contacts = [{ id: 'contact', name: 'Customer', extension: '+44 20 1234 5678' }];

test('matches formatted international numbers and SIP caller URIs', () => {
  expect(callerNameFromContacts('00442012345678', contacts)).toBe('Customer');
  expect(callerNameFromContacts('sip:+442012345678@pbx.example', contacts)).toBe('Customer');
});
test('unknown callers and trunk labels do not become caller names', () => {
  expect(callerNameFromContacts('dongle0', contacts)).toBe('Unknown');
  expect(callerNameFromContacts('12345678', contacts)).toBe('Unknown');
  expect(callerNameFromContacts('', contacts)).toBe('Unknown');
});
test('supports local numbers, extensions and Arabic digits without a hardcoded country', () => {
  expect(callerNameFromContacts('٠١٢٣٤٥٦٧٨٩', [{ id: 'a', name: 'Local', extension: '0123456789' }])).toBe('Local');
  expect(callerNameFromContacts('204', [{ id: 'b', name: 'Colleague', extension: '204' }])).toBe('Colleague');
});
