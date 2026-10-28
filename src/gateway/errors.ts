/**
 * Typed gateway failures. `kind` drives both retry policy and the (existing)
 * login status/error copy — the UI never gets a raw stack trace.
 */
export type GatewayErrorKind =
  | 'pending'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'pbx_disabled'
  | 'fail_closed'
  | 'network'
  | 'unauthorized'
  | 'invalid'
  | 'aborted';

export type GatewayErrorOptions = {
  status?: number;
  retryAfterMs?: number;
  code?: string;
};

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly code?: string;

  constructor(kind: GatewayErrorKind, message: string, options: GatewayErrorOptions = {}) {
    super(message);
    this.name = 'GatewayError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code;
  }
}

export const isGatewayError = (error: unknown): error is GatewayError =>
  error instanceof GatewayError;

/** A gateway that answered the capability probe but cannot serve us: never fall back. */
export const failClosed = (message: string, options: GatewayErrorOptions = {}): GatewayError =>
  new GatewayError('fail_closed', message, options);

export const isTerminalEnrollmentError = (error: unknown): boolean =>
  isGatewayError(error) && (error.kind === 'rejected' || error.kind === 'revoked' || error.kind === 'unauthorized');

/** Login copy for enrollment failures. Reuses the existing login error/status slot. */
export function describeEnrollmentError(error: unknown): string {
  if (!isGatewayError(error)) {
    return error instanceof Error && error.message
      ? error.message
      : 'Device enrollment failed.';
  }
  switch (error.kind) {
    case 'rejected':
      return 'This device was not approved by the administrator.';
    case 'revoked':
      return 'This device has been revoked. Contact your administrator.';
    case 'pbx_disabled':
      return 'The PBX is disabled for this account. Waiting for the administrator…';
    case 'unauthorized':
      return 'The gateway rejected this device credential.';
    case 'fail_closed':
      return 'Gateway detected but unreachable. Direct PBX fallback is disabled.';
    case 'network':
      return 'Cannot reach the gateway. Check the server host and try again.';
    case 'expired':
      return 'The enrollment request expired. Please sign in again.';
    case 'aborted':
      return 'Device enrollment was cancelled.';
    default:
      return error.message || 'Device enrollment failed.';
  }
}
