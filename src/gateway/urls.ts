import { isPrivateHost, splitHost } from '../network';

/**
 * Canonical host for storage keys and comparisons: no scheme, no path,
 * optional explicit port, lowercase.
 */
export function normalizeServerHost(host: string): string {
  const { hostname, port } = splitHost(host);
  if (!hostname) return '';
  return `${hostname.toLowerCase()}${port ? `:${port}` : ''}`;
}

/**
 * Gateway service base URL.
 *
 * Public deployments serve the gateway on HTTP port 80; private/LAN/tailnet
 * deployments keep the existing 8095 default. An explicit port in the host
 * wins over both.
 */
export function gatewayBaseUrl(host: string): string {
  const { hostname, port } = splitHost(host);
  if (!hostname) return '';
  if (port) return `http://${hostname}:${port}`;
  return `http://${hostname}${isPrivateHost(hostname) ? ':8095' : ''}`;
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
