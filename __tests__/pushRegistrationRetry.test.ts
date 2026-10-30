import { createRegistrationRetry } from '../src/push/registrationRetry';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('push registration recovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries transient registration failure without a token-refresh event', async () => {
    const retry = createRegistrationRetry();
    const register = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    retry.start(register);
    await flush();
    expect(register).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(register).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(register).toHaveBeenCalledTimes(2);
    await retry.stop();
  });

  it('caps backoff and recovers thrown failures', async () => {
    const retry = createRegistrationRetry();
    const register = jest.fn().mockRejectedValue(new Error('offline'));
    retry.start(register);
    await flush();
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const count = register.mock.calls.length;
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(register).toHaveBeenCalledTimes(count);
      await jest.advanceTimersByTimeAsync(1);
      expect(register).toHaveBeenCalledTimes(count + 1);
    }
    await retry.stop();
  });

  it('does not retry a failed request after logout', async () => {
    const retry = createRegistrationRetry();
    let finish!: (ok: boolean) => void;
    const register = jest.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    retry.start(register);
    let drained = false;
    const stopped = retry.stop().then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    finish(false);
    await stopped;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('serializes account/token replacement and never retries the old task', async () => {
    const retry = createRegistrationRetry();
    let finish!: (ok: boolean) => void;
    const previous = jest.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const replacement = jest.fn().mockResolvedValue(true);
    retry.start(previous);
    retry.start(replacement);
    expect(replacement).not.toHaveBeenCalled();
    finish(false);
    await flush();
    expect(replacement).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
    await retry.stop();
  });
});
