import {
  MEDIA_CONFIGURATION_PATH,
  buildMediaConfiguration,
  extensionHeaders,
  getMediaConfiguration,
  isPrivateHost,
  normalizeIceServers,
  requiresRelay,
  splitHost,
} from '../src/network';

/** Independent HMAC implementation (Node crypto) to validate the canonical form. */
const nodeCrypto = jest.requireActual('crypto') as {
  createHmac: (
    algorithm: string,
    key: string,
  ) => { update: (data: string) => { digest: (encoding: 'hex') => string } };
};

const expectedSignature = (secret: string, canonical: string) =>
  nodeCrypto.createHmac('sha256', secret).update(canonical).digest('hex');

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const jsonResponse = (body: unknown, status = 200): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('isPrivateHost', () => {
  test.each([
    'localhost',
    'pbx.local',
    '10.1.2.3',
    '127.0.0.1',
    '192.168.100.5',
    '172.16.0.1',
    '172.31.255.254',
    '100.98.185.86', // Tailscale / CGNAT range
    '100.64.0.1',
    ' 10.0.0.5 ',
  ])('treats %s as private (LAN) media', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  test.each([
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.0.1',
    '100.128.0.1',
    '100.0.0.1',
    'pbx.example.com',
    'sokrat.example.com.',
    '1.2.3.4:8080',
    '',
    'fd00::1',
  ])('treats %s as public (needs TURN)', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe('splitHost', () => {
  test('accepts bare hosts, URLs and explicit ports', () => {
    expect(splitHost('pbx.example.com')).toEqual({ hostname: 'pbx.example.com', port: undefined });
    expect(splitHost('http://pbx.example.com/')).toEqual({ hostname: 'pbx.example.com', port: undefined });
    expect(splitHost('pbx.example.com:8080')).toEqual({ hostname: 'pbx.example.com', port: '8080' });
    expect(splitHost('ws://10.0.0.5:8088/ws')).toEqual({ hostname: '10.0.0.5', port: '8088' });
    expect(splitHost('  pbx.example.com  ')).toEqual({ hostname: 'pbx.example.com', port: undefined });
    expect(splitHost('[fd00::1]:8089')).toEqual({ hostname: 'fd00::1', port: '8089' });
    expect(splitHost('')).toEqual({ hostname: '' });
    expect(splitHost(undefined as unknown as string)).toEqual({ hostname: '' });
  });
});

describe('extensionHeaders', () => {
  test('signs <extension>\\n<timestamp>\\n<METHOD>\\n<path> with the SIP password', () => {
    const timestamp = '1761600000000';
    const headers = extensionHeaders({
      extension: '160',
      password: 'secret-pass',
      path: MEDIA_CONFIGURATION_PATH,
      timestamp,
    });

    expect(headers).toEqual({
      'X-Sokrat-Extension': '160',
      'X-Sokrat-Timestamp': timestamp,
      'X-Sokrat-Signature': expectedSignature(
        'secret-pass',
        `160\n${timestamp}\nGET\n${MEDIA_CONFIGURATION_PATH}`,
      ),
    });
  });

  test('binds the signature to method, path, extension and password', () => {
    const base = { extension: '160', password: 'pw', path: '/api/mobile/ice', timestamp: '1' };
    const signature = (input: Parameters<typeof extensionHeaders>[0]) =>
      extensionHeaders(input)['X-Sokrat-Signature'];

    expect(signature(base)).toBe(expectedSignature('pw', '160\n1\nGET\n/api/mobile/ice'));
    expect(signature({ ...base, method: 'post' })).toBe(expectedSignature('pw', '160\n1\nPOST\n/api/mobile/ice'));
    expect(signature({ ...base, path: '/api/extension/v1/contacts' })).not.toBe(signature(base));
    expect(signature({ ...base, extension: '162' })).not.toBe(signature(base));
    expect(signature({ ...base, password: 'other' })).not.toBe(signature(base));
  });

  test('defaults to the current time', () => {
    const before = Date.now();
    const headers = extensionHeaders({ extension: '160', password: 'pw', path: '/api/mobile/ice' });
    const timestamp = Number(headers['X-Sokrat-Timestamp']);
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });
});

describe('normalizeIceServers / requiresRelay', () => {
  test('normalizes strings, arrays and drops unusable entries', () => {
    const servers = normalizeIceServers([
      { urls: ' turn:turn.example.com:3478?transport=udp ', username: 'u', credential: 'c' },
      { urls: ['stun:stun.example.com:3478', '   ', ''], username: '', credential: '' },
      { urls: [] },
      { urls: 42 },
      null,
      42,
      ' turn:turn2.example.com:3478 ',
    ]);

    expect(servers).toEqual([
      { urls: 'turn:turn.example.com:3478?transport=udp', username: 'u', credential: 'c' },
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn2.example.com:3478' },
    ]);
    expect(requiresRelay(servers)).toBe(true);
  });

  test('handles non-array payloads and STUN-only configs', () => {
    expect(normalizeIceServers(undefined)).toEqual([]);
    expect(normalizeIceServers('turn:example.com')).toEqual([]);
    expect(requiresRelay([{ urls: ['stun:a.example.com', 'stun:b.example.com'] }])).toBe(false);
    expect(requiresRelay([])).toBe(false);
  });
});

describe('buildMediaConfiguration', () => {
  test('forces relay policy only when TURN credentials are present', () => {
    const configuration = buildMediaConfiguration({
      iceServers: [
        { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' },
        { urls: 'stun:stun.example.com:3478' },
      ],
    });

    expect(configuration.iceTransportPolicy).toBe('relay');
    expect(configuration.iceServers).toHaveLength(2);
  });

  test('does not force relay when only STUN is returned', () => {
    const configuration = buildMediaConfiguration({ iceServers: ['stun:stun.example.com:3478'] });
    expect(configuration.iceServers).toEqual([{ urls: 'stun:stun.example.com:3478' }]);
    expect(configuration.iceTransportPolicy).toBeUndefined();
  });

  test('accepts snake_case payloads', () => {
    expect(buildMediaConfiguration({ ice_servers: ['turn:turn.example.com:3478'] })).toEqual({
      iceServers: [{ urls: 'turn:turn.example.com:3478' }],
      iceTransportPolicy: 'relay',
    });
  });

  test('rejects an empty or unusable payload', () => {
    expect(() => buildMediaConfiguration({ iceServers: [] })).toThrow('Audio relay unavailable');
    expect(() => buildMediaConfiguration({})).toThrow('Audio relay unavailable');
    expect(() => buildMediaConfiguration(null)).toThrow('Audio relay unavailable');
  });
});

describe('getMediaConfiguration', () => {
  test('returns host candidates only on private hosts (no network call)', async () => {
    const fetcher = jest.fn();
    await expect(
      getMediaConfiguration('192.168.100.5', '160', 'pw', { fetcher: fetcher as never }),
    ).resolves.toEqual({ iceServers: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('fetches signed TURN credentials from a public PBX', async () => {
    const fetcher = jest.fn(async () =>
      jsonResponse({
        iceServers: [
          { urls: 'turn:turn.example.com:3478', username: 'turn-user', credential: 'turn-secret' },
        ],
      }),
    );

    const configuration = await getMediaConfiguration('http://pbx.example.com/', '160', 'pw', {
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://pbx.example.com${MEDIA_CONFIGURATION_PATH}`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sokrat-Extension']).toBe('160');
    expect(headers['X-Sokrat-Signature']).toBe(
      expectedSignature('pw', `160\n${headers['X-Sokrat-Timestamp']}\nGET\n/api/extension/v1/whoami`),
    );
    expect(configuration.iceTransportPolicy).toBe('relay');
    expect(configuration.iceServers).toEqual([
      { urls: 'turn:turn.example.com:3478', username: 'turn-user', credential: 'turn-secret' },
    ]);
  });

  test('keeps an explicit port when one is configured', async () => {
    const fetcher = jest.fn(async () => jsonResponse({ iceServers: ['stun:stun.example.com:3478'] }));
    await getMediaConfiguration('pbx.example.com:8080', '160', 'pw', {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(
      `http://pbx.example.com:8080${MEDIA_CONFIGURATION_PATH}`,
    );
  });

  test('surfaces authorization failures with the status code', async () => {
    const fetcher = jest.fn(async () => jsonResponse({ error: 'bad signature' }, 401));
    await expect(
      getMediaConfiguration('pbx.example.com', '160', 'pw', { fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toThrow('Audio relay authorization failed (401)');
  });

  test('rejects unusable relay payloads', async () => {
    const fetcher = jest.fn(async () => jsonResponse({ iceServers: [] }));
    await expect(
      getMediaConfiguration('pbx.example.com', '160', 'pw', { fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toThrow('Audio relay unavailable');
  });

  test('rejects malformed JSON responses', async () => {
    const fetcher = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <');
      },
    }));
    await expect(
      getMediaConfiguration('pbx.example.com', '160', 'pw', { fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toThrow('Audio relay response was not valid JSON');
  });

  test('wraps transport errors', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('Network request failed');
    });
    await expect(
      getMediaConfiguration('pbx.example.com', '160', 'pw', { fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toThrow('Audio relay unreachable: Network request failed');
  });

  test('aborts and reports a timeout', async () => {
    const fetcher = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        }),
    );

    await expect(
      getMediaConfiguration('pbx.example.com', '160', 'pw', {
        timeoutMs: 5,
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow('Audio relay request timed out');
  });

  test('rejects a missing host before any network call', async () => {
    const fetcher = jest.fn();
    await expect(
      getMediaConfiguration('', '160', 'pw', { fetcher: fetcher as never }),
    ).rejects.toThrow('Server host is not configured');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
