import {
  buildWhatsAppAppUrl,
  buildWhatsAppWebUrl,
  resolveWhatsAppNumber,
  sanitizeCountryCode,
} from '../src/utils/whatsapp';

describe('WhatsApp number resolution', () => {
  test('accepts international numbers in + and 00 formats', () => {
    expect(resolveWhatsAppNumber('+20 106 512 1791')).toEqual({
      status: 'ready',
      digits: '201065121791',
    });
    expect(resolveWhatsAppNumber('00201065121791')).toEqual({
      status: 'ready',
      digits: '201065121791',
    });
  });

  test('asks for a country code for local numbers', () => {
    expect(resolveWhatsAppNumber('01065121791')).toEqual({
      status: 'needs-country-code',
      digits: '01065121791',
    });
  });

  test('prepends the country code and strips the trunk zero', () => {
    expect(resolveWhatsAppNumber('01065121791', '20')).toEqual({
      status: 'ready',
      digits: '201065121791',
    });
  });

  test('rejects extensions and feature codes', () => {
    expect(resolveWhatsAppNumber('101', '20')).toEqual({
      status: 'ineligible',
      reason: 'extension',
    });
    expect(resolveWhatsAppNumber('*43', '20')).toEqual({
      status: 'ineligible',
      reason: 'feature-code',
    });
  });

  test('rejects non-numeric input', () => {
    expect(resolveWhatsAppNumber('support', '20')).toEqual({
      status: 'ineligible',
      reason: 'invalid',
    });
  });

  test('sanitizes country codes and builds links', () => {
    expect(sanitizeCountryCode('+20 ')).toBe('20');
    expect(buildWhatsAppAppUrl('201065121791')).toBe(
      'whatsapp://send?phone=201065121791',
    );
    expect(buildWhatsAppWebUrl('201065121791')).toBe(
      'https://wa.me/201065121791',
    );
  });
});
