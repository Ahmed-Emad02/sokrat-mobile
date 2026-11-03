import { StorageService, type SavedAccount, type Contact } from '../storage/store';
import { extensionHeaders, isPrivateHost, splitHost } from '../network';
import { getOrLoadGatewaySession } from '../gateway/session';
import { callerNameFromContacts, callDisplayName } from './callerName';
import { lookupDeviceContactName } from './nativeCallNotification';

export const CONTACTS_PATH = '/api/extension/v1/contacts?limit=2000';

/** A lookup failure is not a call failure. Never use a SIP display label here. */
export async function resolveCallerName(number: string, account: SavedAccount | null): Promise<string> {
  try {
    const device = await lookupDeviceContactName(number);
    if (device) {
      const resolved = callDisplayName(number, device);
      if (resolved !== callDisplayName(number)) return resolved;
    }
  } catch { /* Contacts permission or lookup failure falls back below. */ }
  try {
    const local = callerNameFromContacts(number, await StorageService.getContacts());
    if (local !== 'Unknown') return local;
  } catch { /* A corrupt local store must not suppress the server lookup. */ }
  if (!account?.serverHost || !account.extension || !account.password) return 'Unknown';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const session = await getOrLoadGatewaySession(account.serverHost, account.extension);
    const { hostname, port } = splitHost(account.serverHost);
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    const base = session?.apiURL || `${account.useTls ? 'https' : 'http'}://${host}:${port || (isPrivateHost(hostname) ? '8080' : (account.useTls ? '443' : '80'))}`;
    const path = session ? '/api/gateway/contacts?limit=2000' : CONTACTS_PATH;
    const response = await fetch(base.replace(/\/+$/, '') + path, {
      headers: {
        Accept: 'application/json',
        ...extensionHeaders({ extension: account.extension, password: account.password, path: CONTACTS_PATH }),
        ...(session ? { Authorization: `Bearer ${session.claimSecret}`, 'X-Sokrat-Device': session.deviceId } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return 'Unknown';
    const data = await response.json();
    const contacts: Contact[] = (Array.isArray(data.contacts) ? data.contacts : []).map((raw: Record<string, unknown>) => ({
      id: String(raw.id || ''),
      name: [raw.first_name ?? raw.firstName ?? raw.name, raw.last_name ?? raw.lastName].filter(Boolean).join(' ').trim(),
      extension: String(raw.phone ?? raw.telefono ?? raw.extension ?? ''),
    }));
    return callerNameFromContacts(number, contacts);
  } catch {
    return 'Unknown';
  } finally {
    clearTimeout(timer);
  }
}
