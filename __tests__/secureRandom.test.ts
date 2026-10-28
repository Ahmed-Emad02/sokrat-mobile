/**
 * The enrollment claim secret activates as a bearer credential, so the only
 * acceptable sources are platform CSPRNGs. These tests pin the fail-closed
 * policy: no Math.random / timestamp fallback is ever used.
 */
jest.mock('react-native', () => ({ NativeModules: {} }));

import { NativeModules } from 'react-native';
import {
  getSecureRandomHex,
  SecureRandomUnavailableError,
} from '../src/gateway/secureRandom';

const nativeModules = NativeModules as Record<string, unknown>;
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function withoutWebCrypto<T>(run: () => Promise<T>): Promise<T> {
  Object.defineProperty(globalThis, 'crypto', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  return run().finally(() => {
    if (cryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    } else {
      delete (globalThis as unknown as Record<string, unknown>).crypto;
    }
  });
}

afterEach(() => {
  delete nativeModules.SokratSecureRandom;
  jest.restoreAllMocks();
});

describe('secure random source', () => {
  test('uses WebCrypto when the runtime exposes it', async () => {
    const webcrypto = (globalThis as unknown as {
      crypto: { getRandomValues: (array: Uint8Array) => Uint8Array };
    }).crypto;
    const spy = jest.spyOn(webcrypto, 'getRandomValues');
    const hex = await getSecureRandomHex(32);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('uses the native SecureRandom bridge when WebCrypto is absent', async () => {
    const getRandomHex = jest.fn(async (bytes: number) => 'ab'.repeat(bytes));
    nativeModules.SokratSecureRandom = { getRandomHex };

    const hex = await withoutWebCrypto(() => getSecureRandomHex(32));

    expect(hex).toBe('ab'.repeat(32));
    expect(getRandomHex).toHaveBeenCalledWith(32);
  });

  test('fails closed when no CSPRNG is available', async () => {
    await expect(withoutWebCrypto(() => getSecureRandomHex(32))).rejects.toBeInstanceOf(
      SecureRandomUnavailableError,
    );
    await expect(withoutWebCrypto(() => getSecureRandomHex(32))).rejects.toMatchObject({
      kind: 'fail_closed',
      message: expect.stringContaining('Secure random source unavailable'),
    });
  });

  test('never falls back to Math.random', async () => {
    const mathRandom = jest.spyOn(Math, 'random');
    await expect(withoutWebCrypto(() => getSecureRandomHex(32))).rejects.toBeInstanceOf(
      SecureRandomUnavailableError,
    );
    expect(mathRandom).not.toHaveBeenCalled();
  });

  test('rejects native output of the wrong length or encoding', async () => {
    nativeModules.SokratSecureRandom = {
      getRandomHex: jest.fn(async () => 'abcd'),
    };
    await expect(withoutWebCrypto(() => getSecureRandomHex(32))).rejects.toBeInstanceOf(
      SecureRandomUnavailableError,
    );

    nativeModules.SokratSecureRandom = {
      getRandomHex: jest.fn(async () => 'zz'.repeat(32)),
    };
    await expect(withoutWebCrypto(() => getSecureRandomHex(32))).rejects.toBeInstanceOf(
      SecureRandomUnavailableError,
    );
  });

  test('fails closed when the native bridge rejects', async () => {
    nativeModules.SokratSecureRandom = {
      getRandomHex: jest.fn(async () => {
        throw new Error('entropy pool unavailable');
      }),
    };
    await expect(withoutWebCrypto(() => getSecureRandomHex(32))).rejects.toMatchObject({
      kind: 'fail_closed',
      message: expect.stringContaining('entropy pool unavailable'),
    });
  });

  test('rejects invalid byte lengths before touching a source', async () => {
    await expect(getSecureRandomHex(0)).rejects.toBeInstanceOf(SecureRandomUnavailableError);
    await expect(getSecureRandomHex(2048)).rejects.toBeInstanceOf(SecureRandomUnavailableError);
  });
});
