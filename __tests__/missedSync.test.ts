import { fetchMissedCalls, type MissedFetcher } from '../src/calls/missedSync';

function response(body: unknown) {
  return { ok: true, json: async () => body };
}

function page(start: number, count: number, hasMore: boolean, nextSince = '2026-11-04T10:00:00.000Z') {
  return {
    missedCalls: Array.from({ length: count }, (_, index) => ({
      callId: `call-${start + index}`,
      callerId: '100',
      callerName: 'Caller',
      startedAt: 1760000000000 + start + index,
      recordedAt: 1760000100000 + start + index,
    })),
    hasMore,
    nextSince,
  };
}

describe('missed-call pagination', () => {
  test('fetches all legacy pages and returns the final cursor', async () => {
    const offsets: number[] = [];
    const fetcher: MissedFetcher = async (input) => {
      const offset = Number(new URL(input).searchParams.get('offset'));
      offsets.push(offset);
      if (offset === 0) return response(page(0, 100, true));
      if (offset === 100) return response(page(100, 100, true));
      return response(page(200, 5, false, '2026-11-04T10:05:00.000Z'));
    };

    const result = await fetchMissedCalls({
      since: '2026-11-04T09:00:00.000Z',
      legacy: { baseUrl: 'http://gateway.test', extension: '111', deviceUuid: 'uuid' },
      fetcher,
    });

    expect(offsets).toEqual([0, 100, 200]);
    expect(result.missed).toHaveLength(205);
    expect(result.missed[0].callId).toBe('call-0');
    expect(result.missed[204].callId).toBe('call-204');
    expect(result.nextCursor).toBe('2026-11-04T10:05:00.000Z');
  });

  test('does not advance the cursor when a later page fails', async () => {
    let cursor = '2026-11-04T09:00:00.000Z';
    let calls = 0;
    const fetcher: MissedFetcher = async () => {
      calls += 1;
      if (calls === 1) return response(page(0, 100, true));
      return { ok: false, json: async () => ({}) };
    };

    await expect(fetchMissedCalls({
      since: cursor,
      legacy: { baseUrl: 'http://gateway.test', extension: '111', deviceUuid: 'uuid' },
      fetcher,
    })).rejects.toThrow('failed at offset 100');

    expect(cursor).toBe('2026-11-04T09:00:00.000Z');
  });
});
