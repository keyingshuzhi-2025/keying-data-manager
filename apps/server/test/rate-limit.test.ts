import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

describe('RateLimiter 固定窗口限流', () => {
  it('窗口内允许 max 次，超出后返回需等待毫秒数', () => {
    const limiter = new RateLimiter({ enabled: true, max: 3, windowMs: 60_000 });
    const now = 1_000;
    expect(limiter.consume('k', now)).toBe(0);
    expect(limiter.consume('k', now)).toBe(0);
    expect(limiter.consume('k', now)).toBe(0);
    const blocked = limiter.consume('k', now);
    expect(blocked).toBeGreaterThan(0);
    expect(blocked).toBeLessThanOrEqual(60_000);
  });

  it('窗口到期后自动重置', () => {
    const limiter = new RateLimiter({ enabled: true, max: 1, windowMs: 1_000 });
    expect(limiter.consume('k', 0)).toBe(0);
    expect(limiter.consume('k', 500)).toBeGreaterThan(0);
    expect(limiter.consume('k', 1_001)).toBe(0); // 新窗口
  });

  it('不同 key 相互独立', () => {
    const limiter = new RateLimiter({ enabled: true, max: 1, windowMs: 60_000 });
    expect(limiter.consume('a', 0)).toBe(0);
    expect(limiter.consume('b', 0)).toBe(0);
    expect(limiter.consume('a', 0)).toBeGreaterThan(0);
    expect(limiter.consume('b', 0)).toBeGreaterThan(0);
  });

  it('禁用时始终放行', () => {
    const limiter = new RateLimiter({ enabled: false, max: 1, windowMs: 1_000 });
    expect(limiter.consume('k')).toBe(0);
    expect(limiter.consume('k')).toBe(0);
    expect(limiter.consume('k')).toBe(0);
  });
});
