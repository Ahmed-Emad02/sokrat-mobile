import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** Path that mints short-lived TURN credentials for a SIP extension. */
export const MEDIA_CONFIGURATION_PATH = '/api/mobile/ice';
/** The gateway forwards authentication to this exact PBX verifier path. */
export const MEDIA_AUTHENTICATION_PATH = '/api/extension/v1/whoami';
export const MEDIA_CONFIGURATION_TIMEOUT_MS = 8000;

/**
 * Hosts reachable without NAT traversal. On these the media path is LAN-only,
 * so host candidates are enough and no TURN round-trip is needed.
 * `100.64.0.0/10` is included because that is the CGNAT / Tailscale range.
 */
export const isPrivateHost = (host: string): boolean => {
  const value = host.trim().toLowerCase();
  if (value === 'localhost' || value.endsWith('.local')) return true;
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
};

export type ExtensionAuthRequest = {
  extension: string;
  password: string;
  /** Request path the signature covers, exactly as it appears on the wire. */
  path: string;
  method?: string;
  timestamp?: string;
};

/**
 * HMAC headers for the PBX extension API.
 * Canonical form: `<extension>\n<timestamp>\n<METHOD>\n<path>`.
 */
export function extensionHeaders({
  extension,
  password,
  path,
  method = 'GET',
  timestamp = String(Date.now()),
}: ExtensionAuthRequest): Record<string, string> {
  const canonical = `${extension}\n${timestamp}\n${method.toUpperCase()}\n${path}`;
  return {
    'X-Sokrat-Extension': extension,
    'X-Sokrat-Timestamp': timestamp,
    'X-Sokrat-Signature': bytesToHex(hmac(sha256, utf8ToBytes(password), utf8ToBytes(canonical))),
  };
}

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

export type MediaConfiguration = {
  iceServers: IceServer[];
  iceTransportPolicy?: 'relay';
};

export type MediaConfigurationOptions = {
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

const TURN_URL_PATTERN = /^turns?:/i;

/**
 * Accept both `host`, `host:port` and full URLs typed into the login screen,
 * and return the bare hostname plus an optional explicit port.
 */
export function splitHost(host: string): { hostname: string; port?: string } {
  const authority = (host || '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split(/[/?#]/)[0];
  if (!authority) return { hostname: '' };
  const ipv6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(authority);
  if (ipv6) return { hostname: ipv6[1], port: ipv6[2] };
  const [hostname, port] = authority.split(':');
  return {
    hostname: (hostname || '').trim(),
    port: port && /^\d{1,5}$/.test(port) ? port : undefined,
  };
}

/** Keep only usable ICE entries; drop blanks instead of shipping a broken pcConfig. */
export function normalizeIceServers(raw: unknown): IceServer[] {
  if (!Array.isArray(raw)) return [];
  const servers: IceServer[] = [];
  for (const entry of raw) {
    // Tolerate both `{ urls }` objects and bare URL strings.
    if (typeof entry === 'string') {
      const url = entry.trim();
      if (url) servers.push({ urls: url });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { urls?: unknown; url?: unknown; username?: unknown; credential?: unknown };
    const source = value.urls ?? value.url;
    const urls = (Array.isArray(source) ? source : [source])
      .filter((url): url is string => typeof url === 'string')
      .map(url => url.trim())
      .filter(url => url.length > 0);
    if (!urls.length) continue;
    const server: IceServer = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof value.username === 'string' && value.username) server.username = value.username;
    if (typeof value.credential === 'string' && value.credential) server.credential = value.credential;
    servers.push(server);
  }
  return servers;
}

/** True when at least one TURN (not STUN) URL is configured. */
export function requiresRelay(servers: IceServer[]): boolean {
  return servers.some(server =>
    (Array.isArray(server.urls) ? server.urls : [server.urls])
      .some(url => TURN_URL_PATTERN.test(url)),
  );
}

/**
 * Turn an `/api/mobile/ice` payload into a `pcConfig`.
 * Relay policy is only forced when a TURN server is actually present —
 * otherwise `relay` would leave the peer connection without candidates.
 */
export function buildMediaConfiguration(payload: unknown): MediaConfiguration {
  const record = (payload || {}) as { iceServers?: unknown; ice_servers?: unknown };
  const iceServers = normalizeIceServers(record.iceServers ?? record.ice_servers);
  if (!iceServers.length) throw new Error('Audio relay unavailable');
  return requiresRelay(iceServers) ? { iceServers, iceTransportPolicy: 'relay' } : { iceServers };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Resolve the ICE configuration for a call.
 *
 * Private/LAN hosts short-circuit to host candidates. Public hosts must ask the
 * PBX for HMAC-signed TURN credentials; a failure is fatal for the call because
 * a relay-only public deployment would otherwise connect with no audio.
 */
export async function getMediaConfiguration(
  host: string,
  extension: string,
  password: string,
  options: MediaConfigurationOptions = {},
): Promise<MediaConfiguration> {
  const { hostname, port } = splitHost(host);
  if (!hostname) throw new Error('Server host is not configured');
  if (isPrivateHost(hostname)) return { iceServers: [] };

  const url = `http://${hostname}${port ? `:${port}` : ''}${MEDIA_CONFIGURATION_PATH}`;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MEDIA_CONFIGURATION_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...extensionHeaders({ extension, password, path: MEDIA_AUTHENTICATION_PATH }),
      },
      signal: controller.signal,
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'AbortError') throw new Error('Audio relay request timed out');
    throw new Error(`Audio relay unreachable: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`Audio relay authorization failed (${response.status})`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Audio relay response was not valid JSON');
  }
  return buildMediaConfiguration(payload);
}
