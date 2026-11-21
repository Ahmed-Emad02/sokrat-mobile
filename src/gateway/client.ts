/**
 * Low-level, authenticated client for the gateway device-enrollment API.
 *
 * Endpoints (all on the gateway host):
 *   GET  /api/gateway/capabilities
 *   POST /api/gateway/enrollment/enroll
 *   POST /api/gateway/enrollment/claim
 *   GET  /api/gateway/ice
 *   POST /api/gateway/sip-ticket
 *   POST /api/gateway/register-device
 *   POST /api/gateway/remove-device
 */
import { normalizeIceServers, type IceServer, type MediaConfiguration } from '../network';
import { GatewayError, failClosed } from './errors';
import type {
  ClaimResponse,
  EnrollmentStatus,
  EnrollResponse,
  GatewayAssignment,
  GatewayCallState,
  GatewayCapabilities,
  GatewayVpnProfile,
} from './types';
import { gatewayAuthHeaders, joinUrl } from './urls';

export const GATEWAY_TIMEOUT_MS = 8000;
export const DEFAULT_CLAIM_POLL_MS = 3000;
export const DEFAULT_BUSY_RETRY_MS = 5000;

type Fetcher = typeof fetch;

export type GatewayClientOptions = {
  baseUrl: string;
  claimSecret?: string;
  deviceId?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
};

export type EnrollInput = {
  /** Local fallback only: short-lived PBX extension HMAC proof headers. */
  extensionAuth?: Record<string, string>;
  claimSecret: string;
  platform: 'android' | 'ios';
  deviceUuid: string;
  extension: string;
  deviceName: string;
  appVersion: string;
};

type JsonBody = Record<string, unknown> | null;

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function bodyString(body: JsonBody, key: string): string {
  const value = body?.[key];
  return typeof value === 'string' ? value : '';
}

function bodyNumber(body: JsonBody, key: string): number | undefined {
  const value = body?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseVpnProfile(raw: unknown): GatewayVpnProfile | null {
  const vpn = asRecord(raw);
  if (!vpn || vpn.enabled !== true) return null;
  const endpoint = bodyString(vpn, 'endpoint');
  const serverPublicKey = bodyString(vpn, 'serverPublicKey');
  const address = bodyString(vpn, 'address');
  const privateSipUrl = bodyString(vpn, 'privateSipUrl');
  const sipDomain = bodyString(vpn, 'sipDomain');
  const allowedIPs = Array.isArray(vpn.allowedIPs)
    ? vpn.allowedIPs.filter((item): item is string => typeof item === 'string')
    : [];
  if (!endpoint || !serverPublicKey || !address || !privateSipUrl || !sipDomain || !allowedIPs.length) return null;
  const mtu = typeof vpn.mtu === 'number' ? vpn.mtu : 1380;
  const keepaliveSeconds = typeof vpn.keepaliveSeconds === 'number' ? vpn.keepaliveSeconds : 25;
  return { enabled: true, endpoint, serverPublicKey, address, allowedIPs, privateSipUrl, sipDomain, mtu, keepaliveSeconds };
}

function parseAssignment(body: JsonBody): GatewayAssignment | null {
  const assignment = asRecord(body?.assignment);
  if (!assignment) return null;
  const deviceId = bodyString(assignment, 'deviceId');
  const extension = bodyString(assignment, 'extension');
  const wsURL = bodyString(assignment, 'wsURL');
  const apiURL = bodyString(assignment, 'apiURL');
  if (!deviceId || !extension) return null;
  const mediaIps = Array.isArray(assignment.mediaIps)
    ? assignment.mediaIps.filter((ip): ip is string => typeof ip === 'string')
    : [];
  const fallbackRaw = asRecord(assignment.directFallback);
  const fallbackWs = bodyString(fallbackRaw, 'wsURL');
  const fallbackApi = bodyString(fallbackRaw, 'apiURL');
  const directFallback = fallbackWs && fallbackApi
    ? { wsURL: fallbackWs, apiURL: fallbackApi }
    : undefined;
  const vpn = parseVpnProfile(assignment.vpn);
  return {
    deviceId,
    pbxId: bodyString(assignment, 'pbxId'),
    pbxName: bodyString(assignment, 'pbxName'),
    extension,
    wsURL,
    apiURL,
    mediaIps,
    ...(directFallback ? { directFallback } : {}),
    ...(vpn ? { vpn } : {}),
  };
}

const enrollmentStatus = (body: JsonBody): EnrollmentStatus | 'pending' => {
  const status = bodyString(body, 'status');
  switch (status) {
    case 'approved':
    case 'pending':
    case 'rejected':
    case 'revoked':
    case 'expired':
    case 'pbx_disabled':
      return status;
    default:
      return 'pending';
  }
};

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  readonly claimSecret?: string;
  readonly deviceId?: string;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? GATEWAY_TIMEOUT_MS;
    this.claimSecret = options.claimSecret;
    this.deviceId = options.deviceId;
  }

  private async call(
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; body: JsonBody }> {
    if (!this.baseUrl) throw failClosed('Gateway host is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(joinUrl(this.baseUrl, path), {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'AbortError') {
        throw new GatewayError('network', `Gateway request timed out: ${path}`);
      }
      throw new GatewayError(
        'network',
        `Gateway unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let body: JsonBody = null;
    try {
      body = asRecord(await response.json());
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  private tenantHeaders(json: boolean): Record<string, string> {
    if (!this.claimSecret) throw new GatewayError('unauthorized', 'Missing device credential');
    return gatewayAuthHeaders({
      claimSecret: this.claimSecret,
      deviceId: this.deviceId,
      json,
    });
  }

  /**
   * Capability probe. `null` means "not a gateway / unreachable" and the caller
   * keeps the direct-PBX behaviour. Anything the gateway answers with other
   * than 404 (including 5xx) is fail-closed: no direct bypass.
   */
  async capabilities(): Promise<GatewayCapabilities | null> {
    let result: { status: number; body: JsonBody };
    try {
      result = await this.call('/api/gateway/capabilities', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (error instanceof GatewayError && error.kind === 'network') {
        // A TLS/connectivity failure must not downgrade a public gateway to
        // plaintext APIs or direct SIP. Private legacy discovery is unchanged.
        if (this.baseUrl.startsWith('https://')) throw error;
        console.log('[gateway] capability probe unreachable; using direct PBX mode');
        return null;
      }
      throw error;
    }

    if (result.status === 404) return null;
    // A busy or briefly unavailable gateway is present, not absent: retry
    // instead of telling the user it is unreachable and stopping the login.
    if (result.status === 429 || result.status >= 500) {
      throw new GatewayError('unavailable', `Gateway busy (HTTP ${result.status})`, {
        status: result.status,
        retryAfterMs: DEFAULT_BUSY_RETRY_MS,
      });
    }
    if (result.status === 403 || result.status === 401) {
      throw new GatewayError('blocked', `Gateway request refused (HTTP ${result.status})`, {
        status: result.status,
      });
    }
    if (result.status !== 200) {
      // Anything else means the origin answered but is not this gateway
      // (wrong port, a different vhost, an intercepting proxy).
      throw new GatewayError('route', `Server answered HTTP ${result.status}, not a PBX gateway`, {
        status: result.status,
      });
    }

    const body = result.body;
    const deviceApproval = body?.deviceApproval === true;
    const version = bodyNumber(body, 'version') ?? 1;
    const enrollmentPath = bodyString(body, 'enrollmentPath') || '/api/gateway/enrollment';
    return { version, deviceApproval, enrollmentPath };
  }

  async enroll(input: EnrollInput): Promise<EnrollResponse> {
    const { status, body } = await this.call('/api/gateway/enrollment/enroll', {
      method: 'POST',
      headers: { ...gatewayAuthHeaders({ claimSecret: input.claimSecret, json: true }), ...(input.extensionAuth || {}) },
      body: JSON.stringify(input),
    });

    if (status === 403) {
      throw this.enrollmentRejection(body);
    }
    if (status === 410) {
      throw new GatewayError('expired', 'Enrollment request expired', { status });
    }
    if (status === 409) {
      const code = bodyString(body, 'error') || bodyString(body, 'code');
      // `pending_cap_reached` is back-pressure: keep waiting. Every other 409
      // here is an identity conflict that only an administrator can clear.
      if (code === 'pending_cap_reached') {
        throw new GatewayError('pbx_disabled', 'PBX disabled for this account', {
          status,
          retryAfterMs: bodyNumber(body, 'retryAfterMs') ?? DEFAULT_BUSY_RETRY_MS,
        });
      }
      throw new GatewayError('conflict', code || 'enrollment_conflict', { status, code });
    }
    if (status !== 200 && status !== 201) {
      throw new GatewayError('invalid', `Enrollment failed (HTTP ${status})`, { status });
    }

    const device = asRecord(body?.device);
    const deviceId = bodyString(device, 'id') || bodyString(body, 'deviceId');
    if (!deviceId) throw new GatewayError('invalid', 'Enrollment response is missing the device id');

    return {
      deviceId,
      status: enrollmentStatus(body),
      retryAfterMs: bodyNumber(body, 'retryAfterMs'),
    };
  }

  /** `claim` returns pending/busy states as values; terminal states throw. */
  async claim(deviceId: string): Promise<ClaimResponse> {
    const { status, body } = await this.call('/api/gateway/enrollment/claim', {
      method: 'POST',
      headers: gatewayAuthHeaders({
        claimSecret: this.claimSecret ?? '',
        deviceId,
        json: true,
      }),
      body: JSON.stringify({ deviceId, claimSecret: this.claimSecret }),
    });

    if (status === 202) {
      return { status: 'pending', retryAfterMs: bodyNumber(body, 'retryAfterMs') ?? DEFAULT_CLAIM_POLL_MS };
    }
    if (status === 200) {
      const assignment = parseAssignment(body);
      if (enrollmentStatus(body) !== 'approved' || !assignment) {
        throw new GatewayError('invalid', 'Claim response is missing the approved assignment', { status });
      }
      return { status: 'approved', assignment };
    }
    if (status === 403) {
      throw this.enrollmentRejection(body);
    }
    if (status === 401) {
      throw new GatewayError('unauthorized', 'Gateway rejected the device credential', { status });
    }
    if (status === 410) {
      throw new GatewayError('expired', 'Enrollment request expired', { status });
    }
    if (status === 409) {
      return {
        status: 'pbx_disabled',
        retryAfterMs: bodyNumber(body, 'retryAfterMs') ?? DEFAULT_BUSY_RETRY_MS,
      };
    }
    throw new GatewayError('invalid', `Claim failed (HTTP ${status})`, { status });
  }

  async iceServers(): Promise<MediaConfiguration> {
    const { status, body } = await this.call('/api/gateway/ice', {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.tenantHeaders(false) },
    });

    if (status === 401 || status === 403) {
      throw new GatewayError('unauthorized', 'Gateway rejected the relay request', { status });
    }
    if (status === 409 || status === 410) throw new GatewayError('pbx_disabled', 'PBX is no longer available', { status });
    if (status !== 200) {
      throw new GatewayError('invalid', `Relay configuration failed (HTTP ${status})`, { status });
    }

    const raw: unknown = body?.iceServers ?? body?.ice_servers;
    const iceServers: IceServer[] = normalizeIceServers(raw);
    if (!iceServers.length) throw new GatewayError('invalid', 'Audio relay unavailable');
    // TURN remains available, but host/STUN candidates may use a direct path.
    return { iceServers };
  }

  async vpnProfile(publicKey?: string): Promise<GatewayVpnProfile | null> {
    const registering = typeof publicKey === 'string' && publicKey.length > 0;
    const { status, body } = await this.call('/api/gateway/vpn/profile', {
      method: registering ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...this.tenantHeaders(registering) },
      ...(registering ? { body: JSON.stringify({ publicKey }) } : {}),
    });
    if (status === 404) return null;
    if (status === 401 || status === 403) {
      throw new GatewayError('unauthorized', 'Gateway rejected the VPN profile request', { status });
    }
    if (status === 409 || status === 410) throw new GatewayError('pbx_disabled', 'PBX is no longer available', { status });
    if (status !== 200) throw new GatewayError('invalid', `VPN profile failed (HTTP ${status})`, { status });
    return parseVpnProfile(body?.vpn);
  }

  async sipTicket(): Promise<{ ticket: string; expiresIn: number }> {
    const { status, body } = await this.call('/api/gateway/sip-ticket', {
      method: 'POST',
      headers: this.tenantHeaders(true),
      body: JSON.stringify({}),
    });

    if (status === 401 || status === 403) {
      throw new GatewayError('unauthorized', 'Gateway rejected the SIP ticket request', { status });
    }
    if (status === 409 || status === 410) throw new GatewayError('pbx_disabled', 'PBX is no longer available', { status });
    if (status !== 200) {
      throw new GatewayError('invalid', `SIP ticket failed (HTTP ${status})`, { status });
    }
    const ticket = bodyString(body, 'ticket');
    if (!ticket) throw new GatewayError('invalid', 'SIP ticket response is empty');
    return { ticket, expiresIn: bodyNumber(body, 'expiresIn') ?? 30 };
  }

  async registerDevice(body: Record<string, string>): Promise<void> {
    const { status } = await this.call('/api/gateway/register-device', {
      method: 'POST',
      headers: this.tenantHeaders(true),
      body: JSON.stringify(body),
    });
    if (status === 401 || status === 403) throw new GatewayError('unauthorized', 'Gateway rejected the device credential', { status });
    // 409 is a token ownership conflict, not evidence of PBX retirement.
    if (status === 409) throw new GatewayError('invalid', 'Push token is already registered', { status });
    if (status === 410) throw new GatewayError('pbx_disabled', 'PBX is no longer available', { status });
    if (status !== 200 && status !== 201 && status !== 202) {
      throw new GatewayError('invalid', `Device registration failed (HTTP ${status})`, { status });
    }
  }

  async removeDevice(body: Record<string, string>): Promise<void> {
    const { status } = await this.call('/api/gateway/remove-device', {
      method: 'POST',
      headers: this.tenantHeaders(true),
      body: JSON.stringify(body),
    });
    if (status !== 200 && status !== 202 && status !== 204) {
      throw new GatewayError('invalid', `Device removal failed (HTTP ${status})`, { status });
    }
  }

  /** Live extension/trunk state for dongle call reconciliation. */
  async callState(extensionAuth: Record<string, string>): Promise<GatewayCallState> {
    const { status, body } = await this.call('/api/gateway/call/state', {
      method: 'POST',
      headers: { ...this.tenantHeaders(true), ...extensionAuth },
      body: JSON.stringify({}),
    });
    if (status === 401 || status === 403) {
      throw new GatewayError('unauthorized', 'Gateway rejected the call-state request', { status });
    }
    if (status === 409 || status === 410) {
      throw new GatewayError('pbx_disabled', 'PBX is no longer available', { status });
    }
    if (status !== 200) {
      throw new GatewayError('invalid', `Call state failed (HTTP ${status})`, { status });
    }
    return {
      callerActive: body?.callerActive === true,
      trunkActive: body?.trunkActive === true,
    };
  }

  /** Acknowledge a keepalive wake so the gateway does not send another. */
  async heartbeat(body: Record<string, string>): Promise<void> {
    const { status } = await this.call('/api/gateway/device/heartbeat', {
      method: 'POST',
      headers: this.tenantHeaders(true),
      body: JSON.stringify(body),
    });
    if (status === 401 || status === 403) {
      throw new GatewayError('unauthorized', 'Gateway rejected the heartbeat', { status });
    }
    if (status === 409 || status === 410) {
      throw new GatewayError('pbx_disabled', 'PBX is no longer available', { status });
    }
    if (status !== 200 && status !== 202 && status !== 204) {
      throw new GatewayError('invalid', `Heartbeat failed (HTTP ${status})`, { status });
    }
  }

  private enrollmentRejection(body: JsonBody): GatewayError {
    const status = bodyString(body, 'status');
    if (status === 'revoked') {
      return new GatewayError('revoked', 'Device has been revoked', { status: 403, code: status });
    }
    return new GatewayError('rejected', 'Device enrollment was rejected', {
      status: 403,
      code: status || 'rejected',
    });
  }
}
