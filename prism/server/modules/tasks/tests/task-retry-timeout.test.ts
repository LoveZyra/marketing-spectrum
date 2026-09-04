import { describe, test, expect } from 'vitest';

import {
  TASK_RETRY_MAX_CONSECUTIVE_FAILURES,
  TaskRunTimeoutError,
  computeRetryAt,
  promiseWithTimeout,
} from '@/modules/tasks/services/scheduled-tasks.service.js';

/**
 * dm 回归:失败重试的判定与单次运行的硬超时。
 * 全部注入时钟/构造 promise,不摸真实定时器之外的东西。
 */
describe('computeRetryAt', () => {
  const now = new Date('2026-08-31T10:00:00Z');
  const farNext = new Date('2026-08-31T18:00:00Z');

  test('first failure retries after five minutes', () => {
    const retryAt = computeRetryAt(['failed'], now, farNext);
    expect(retryAt).not.toBeNull();
    expect(retryAt!.getTime() - now.getTime()).toBe(5 * 60_000);
  });

  test('second consecutive failure still retries; the cap-th one stops', () => {
    expect(computeRetryAt(['failed', 'failed'], now, farNext)).not.toBeNull();
    const capStatuses = Array.from({ length: TASK_RETRY_MAX_CONSECUTIVE_FAILURES }, () => 'failed');
    expect(computeRetryAt(capStatuses, now, farNext)).toBeNull();
  });

  test('a success in between resets the streak', () => {
    const statuses = ['failed', 'completed', 'failed', 'failed'];
    expect(computeRetryAt(statuses, now, farNext)).not.toBeNull();
  });

  test('no retry when the regular next run is already sooner', () => {
    const soonNext = new Date(now.getTime() + 2 * 60_000);
    expect(computeRetryAt(['failed'], now, soonNext)).toBeNull();
  });

  test('no retry without a failure at the head', () => {
    expect(computeRetryAt(['completed', 'failed'], now, farNext)).toBeNull();
    expect(computeRetryAt([], now, farNext)).toBeNull();
  });
});

describe('promiseWithTimeout', () => {
  test('resolves normally under the limit', async () => {
    await expect(promiseWithTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  test('rejects with TaskRunTimeoutError when the promise hangs', async () => {
    const hanging = new Promise(() => { /* never settles */ });
    await expect(promiseWithTimeout(hanging, 10)).rejects.toBeInstanceOf(TaskRunTimeoutError);
  });

  test('propagates the original rejection', async () => {
    const boom = Promise.reject(new Error('boom'));
    await expect(promiseWithTimeout(boom, 1000)).rejects.toThrow('boom');
  });

  test('ms=0 disables the limit', async () => {
    let release: (v: string) => void = () => {};
    const gated = new Promise<string>((resolve) => { release = resolve; });
    const wrapped = promiseWithTimeout(gated, 0);
    release('late');
    await expect(wrapped).resolves.toBe('late');
  });
});
