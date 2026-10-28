export type WhatsAppResolution =
  | { status: 'ready'; digits: string }
  | { status: 'needs-country-code'; digits: string }
  | { status: 'ineligible'; reason: 'empty' | 'feature-code' | 'extension' | 'invalid' };

export function sanitizeCountryCode(raw: string | undefined | null): string {
  return (raw || '').replace(/\D/g, '').slice(0, 4);
}

function isValidWhatsAppDigits(digits: string): boolean {
  return digits.length >= 7 && digits.length <= 15;
}

function ready(digits: string): WhatsAppResolution {
  return isValidWhatsAppDigits(digits)
    ? { status: 'ready', digits }
    : { status: 'ineligible', reason: 'invalid' };
}

/**
 * Resolves a dialed number to the international format expected by WhatsApp.
 *
 * International input (+CC... or 00CC...) is accepted as-is. Local input needs
 * the user's country code; leading trunk zeros are stripped before the country
 * code is prepended. Short numeric extensions and * / # feature codes are
 * never treated as WhatsApp numbers.
 */
export function resolveWhatsAppNumber(
  raw: string,
  countryCode?: string,
): WhatsAppResolution {
  const value = (raw || '').trim();
  if (!value) return { status: 'ineligible', reason: 'empty' };
  if (/[*#]/.test(value)) return { status: 'ineligible', reason: 'feature-code' };
  if (/[a-z]/i.test(value)) return { status: 'ineligible', reason: 'invalid' };

  const digits = value.replace(/\D/g, '');
  if (!digits) return { status: 'ineligible', reason: 'invalid' };

  if (value.startsWith('+') || value.startsWith('00')) {
    return ready(value.startsWith('00') ? digits.replace(/^00/, '') : digits);
  }

  if (digits.length < 7) return { status: 'ineligible', reason: 'extension' };

  const country = sanitizeCountryCode(countryCode);
  if (!country) return { status: 'needs-country-code', digits };

  const local = digits.replace(/^0+/, '');
  if (!local) return { status: 'ineligible', reason: 'invalid' };

  return ready(country + local);
}

export function buildWhatsAppAppUrl(digits: string): string {
  return `whatsapp://send?phone=${digits.replace(/\D/g, '')}`;
}

export function buildWhatsAppWebUrl(digits: string): string {
  return `https://wa.me/${digits.replace(/\D/g, '')}`;
}
