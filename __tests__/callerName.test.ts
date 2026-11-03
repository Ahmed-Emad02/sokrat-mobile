import { callDisplayName, callerNameFromContacts, providerCallerName } from '../src/calls/callerName';

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

test('matches Egyptian international, 00, country-code and local variants', () => {
  const contact = [{ id: 'eg', name: 'Egypt Contact', extension: '+20 101 234 5678' }];
  for (const number of [
    '+201012345678',
    '00201012345678',
    '201012345678',
    '01012345678',
    '1012345678',
  ]) {
    expect(callerNameFromContacts(number, contact)).toBe('Egypt Contact');
  }
});

test('rejects a partial suffix instead of resolving the wrong contact', () => {
  const contact = [{ id: 'eg', name: 'Egypt Contact', extension: '+201012345678' }];
  expect(callerNameFromContacts('0101234567', contact)).toBe('Unknown');
});

test('matches app contacts that use feature-code numbers', () => {
  expect(callerNameFromContacts('*88', [{ id: 'echo', name: 'Echo Audio Test', extension: '*88' }])).toBe('Echo Audio Test');
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

describe('provider caller names', () => {
  test('keeps human provider labels and rejects routing labels', () => {
    expect(providerCallerName('204', 'Ahmed Sales')).toBe('Ahmed Sales');
    expect(providerCallerName('204', 'Dongle/dongle1')).toBe('204');
    expect(providerCallerName('204', 'PJSIP/204-00000001')).toBe('204');
    expect(providerCallerName('204', 'from-internal')).toBe('204');
    expect(providerCallerName('204', 'Unknown')).toBe('204');
    expect(providerCallerName('204', '204')).toBe('204');
  });

  test('uses the first usable provider name', () => {
    expect(providerCallerName('204', 'Unknown', 'Sales Line')).toBe('Sales Line');
    expect(providerCallerName('204', 'Sales Line', 'Support')).toBe('Sales Line');
  });
});
