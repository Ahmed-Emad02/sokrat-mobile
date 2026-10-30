/**
 * Gateway (Sokrat Push Gateway / device-approval service) contract types.
 *
 * A gateway-enabled deployment mints per-device credentials after an admin
 * approves the device. Everything after approval (SIP WS ticket, TURN relay,
 * push registration) is authenticated with `Authorization: Bearer <claimSecret>`
 * plus `X-Sokrat-Device: <deviceId>`.
 */

export type GatewayCapabilities = {
  version: number;
  deviceApproval: boolean;
  enrollmentPath: string;
};

export type EnrollmentStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'pbx_disabled';

export type GatewayAssignment = {
  deviceId: string;
  pbxId: string;
  pbxName: string;
  extension: string;
  wsURL: string;
  apiURL: string;
  mediaIps: string[];
};

export type EnrollmentRecord = {
  host: string;
  extension: string;
  /** 256-bit client secret, persisted per host+extension; the gateway credential. */
  claimSecret: string;
  deviceId?: string;
  /** Stable physical installation identity used for claim and push-token binding. */
  deviceUuid?: string;
  /** Legacy alias accepted when upgrading accounts created by older app builds. */
  enrollmentUuid?: string;
  status: EnrollmentStatus | 'unclaimed';
  gatewayMode: boolean;
  assignment?: GatewayAssignment;
  updatedAt: number;
};

export type GatewaySession = {
  host: string;
  extension: string;
  deviceId: string;
  claimSecret: string;
  assignment: GatewayAssignment;
  /** Base URL for authenticated tenant APIs (assignment.apiURL or gateway base). */
  apiURL: string;
};

export type EnrollResponse = {
  deviceId: string;
  status: EnrollmentStatus | 'pending';
  retryAfterMs?: number;
};

export type ClaimResponse =
  | { status: 'approved'; assignment: GatewayAssignment }
  | { status: 'pending' | 'pbx_disabled'; retryAfterMs?: number };
