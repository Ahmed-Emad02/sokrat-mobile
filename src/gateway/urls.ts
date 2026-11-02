import { isPrivateHost, splitHost } from '../network';
import type { GatewayEndpoint } from './types';

/**
 * Canonical host for storage keys and comparisons: no scheme, no path,
 * optional explicit port, lowercase.
 */
export function normalizeServerHost(host: string): string {
  const { hostname, port } = splitHost(host);
  if (!hostname) return '';
  const authority = hostname.includes(':') ? `[${hostname.toLowerCase()}]` : hostname.toLowerCase();
  return `${authority}${port ? `:${port}` : ''}`;
}

/**
 * Gateway service base URL.
 *
 * Public deployments require HTTPS; private/LAN/tailnet
 * deployments keep the existing 8095 default. An explicit port in the host
 * wins over both.
 */
export function gatewayBaseUrl(host: string): string {
  const { hostname, port } = splitHost(host);
  if (!hostname) return '';
  const privateHost = isPrivateHost(hostname);
  const authority = hostname.includes(':') ? `[${hostname}]` : hostname.toLowerCase();
  const scheme = privateHost ? 'http' : 'https';
  return `${scheme}://${authority}${port ? `:${port}` : privateHost ? ':8095' : ''}`;
}

/**
 * Device-facing WSS URL for a gateway origin.
 *
 * The LAN gateway keeps its API on 18080 and WebSocket on 18088; public
 * gateways use 8089. This is intentionally explicit because the old private
 * 8088 default is the PBX socket, not the gateway.
 */
export function gatewaySipWssUrl(host: string, role: GatewayEndpoint['role']): string {
    const { hostname, port } = splitHost(host);
    if (!hostname) return '';
    const authority = hostname.includes(':') ? `[${hostname}]` : hostname.toLowerCase();
    if (role === 'fallback') {
        return `ws://${authority}:18088/ws`;
    }
    if (!isPrivateHost(hostname)) {
        return `wss://${authority}:8089/ws`;
    }
    return `ws://${authority}:${port || 8088}/ws`;
}

export function fallbackGatewayEndpoint(host: string): GatewayEndpoint | undefined {
    const normalized = normalizeServerHost(host);
    if (!normalized) return undefined;
    const { hostname, port } = splitHost(normalized);
    if (!hostname) return undefined;
    const authority = hostname.includes(':') ? `[${hostname}]` : hostname.toLowerCase();
    return {
        id: 'fallback',
        role: 'fallback',
        host: normalized,
        // The LAN gateway defaults to HTTP/API 18080 when only its host is
        // entered. An explicit port still wins for non-default deployments.
        apiURL: port ? gatewayBaseUrl(normalized) : `http://${authority}:18080`,
        sipWssUrl: gatewaySipWssUrl(normalized, 'fallback'),
    };
}

/** Join a base URL and an API path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  const trimmedBase = (base || '').replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${suffix}`;
}

/** Append query parameters, preserving any query the URL already carries. */
export function appendQuery(url: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, value]) => Boolean(value));
  if (!entries.length) return url;
  const separator = url.includes('?') ? '&' : '?';
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${url}${separator}${query}`;
}

/** Auth headers for every authenticated tenant API call. */
export function gatewayAuthHeaders(options: {
  claimSecret: string;
  deviceId?: string;
  json?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.claimSecret}`,
  };
  if (options.deviceId) headers['X-Sokrat-Device'] = options.deviceId;
  if (options.json) headers['Content-Type'] = 'application/json';
  return headers;
}
