/**
 * Missed-call reconciliation transport.
 *
 * The cursor is returned only after every page has been fetched successfully.
 * A failed later page must not advance the caller's persisted cursor.
 */
export type MissedCallPayload = {
  callId?: string;
  callerId?: string;
  callerName?: string;
  timestamp?: number;
  startedAt?: number;
  recordedAt?: number;
  disposition?: string;
};

export type MissedSyncResult = {
  missed: MissedCallPayload[];
  nextCursor: string;
};

export type MissedFetcher = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> } | null>;

type TenantEndpoint = {
  baseUrl: string;
  headers: Record<string, string>;
};

type LegacyEndpoint = {
  baseUrl: string;
  extension: string;
  deviceUuid: string;
};

function parseCursor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function readJson(response: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await response.json();
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function pageCalls(value: unknown): MissedCallPayload[] {
  return Array.isArray(value) ? value as MissedCallPayload[] : [];
}

export async function fetchMissedCalls(options: {
  since: string;
  tenant?: TenantEndpoint;
  legacy?: LegacyEndpoint;
  fetcher?: MissedFetcher;
}): Promise<MissedSyncResult> {
  const fetcher = options.fetcher ?? (fetch as unknown as MissedFetcher);
  if (options.tenant) {
    const url = `${options.tenant.baseUrl}/api/gateway/missed-calls` +
      `?since=${encodeURIComponent(options.since)}`;
    const response = await fetcher(url, { headers: options.tenant.headers });
    if (!response?.ok) throw new Error('missed-call tenant request failed');
    const json = await readJson(response);
    return {
      missed: pageCalls(json.missedCalls),
      nextCursor: parseCursor(json.nextSince) ?? new Date().toISOString(),
    };
  }
  if (!options.legacy) throw new Error('missed-call endpoint is not configured');

  const missed: MissedCallPayload[] = [];
  let offset = 0;
  while (true) {
    const url = `${options.legacy.baseUrl}/api/push/missed-calls` +
      `?extension=${encodeURIComponent(options.legacy.extension)}` +
      `&deviceUuid=${encodeURIComponent(options.legacy.deviceUuid)}` +
      `&since=${encodeURIComponent(options.since)}` +
      `&limit=100&offset=${offset}`;
    const response = await fetcher(url);
    if (!response?.ok) throw new Error(`missed-call legacy page failed at offset ${offset}`);
    const json = await readJson(response);
    const page = pageCalls(json.missedCalls);
    missed.push(...page);
    if (!json.hasMore) {
      return {
        missed,
        nextCursor: parseCursor(json.nextSince) ?? new Date().toISOString(),
      };
    }
    if (!page.length) throw new Error('missed-call legacy pagination stalled');
    offset += 100;
  }
}
