import { expect, it } from 'vitest';
import { RecoveryPolicy } from './recovery';
it('backs off and stops a crash loop, allows a later stable window or explicit manual retry', () => {
  const policy = new RecoveryPolicy();
  expect([policy.next(100_000), policy.next(100_100), policy.next(100_200), policy.next(100_300)]).toEqual([250, 1000, 3000, undefined]);
  expect(policy.next(161_000)).toBe(250);
  policy.reset();
  expect(policy.next()).toBe(250);
});
