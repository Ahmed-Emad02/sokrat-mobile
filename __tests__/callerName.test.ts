import { callDisplayName, callerNameFromContacts } from '../src/calls/callerName';

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

test.each(['', 'Unknown', ' unknown caller ', 'Incoming Call', 'غير معروف'])('number replaces placeholder display name %s', name => {
  expect(callDisplayName('+44 20 1234 5678', name)).toBe('+44 20 1234 5678');
});
test('display fallback preserves extensions, feature codes, Arabic digits and URI user numbers', () => {
  expect(callDisplayName('204', 'Unknown')).toBe('204');
  expect(callDisplayName('*43', 'Unknown')).toBe('*43');
  expect(callDisplayName('٢٠٤')).toBe('٢٠٤');
  expect(callDisplayName('sip:204@pbx.example', 'Unknown')).toBe('204');
  expect(callDisplayName('204', ' Colleague ')).toBe('Colleague');
});
test('missing or withheld numbers and trunk labels are not invented as caller identities', () => {
  for (const number of ['', 'anonymous', 'restricted', 'dongle0']) {
    expect(callDisplayName(number, 'Unknown')).toBe('Unknown');
  }
});
