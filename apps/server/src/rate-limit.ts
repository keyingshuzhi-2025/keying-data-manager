/**
 * 轻量内存固定窗口限流器（v0.1.2 M2：登录/注册/改密/重置密码限流，429）。
 *
 * 不引入外部依赖（无 @fastify/rate-limit），适用于单节点部署：
 * - 按 IP(+用户名) 键控的固定窗口计数，窗口结束自动重置；
 * - 内存键超过阈值时惰性清扫过期窗口，避免无界增长；
 * - 进程重启即清空计数（单节点可接受；多实例需外部存储，不在当前范围）。
 */
import type { FastifyRequest } from 'fastify';
import { tooManyRequests } from './errors.js';

export interface RateLimitConfig {
  /** 是否启用（生产默认开启，开发/测试默认关闭） */
  enabled: boolean;
  /** 窗口内允许的最大尝试次数 */
  max: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(public readonly config: RateLimitConfig) {}

  /**
   * 消费一次额度。返回 0 表示放行；返回 >0 表示被限流，值为需等待的毫秒数。
   * 为方便测试，可注入当前时间。
   */
  consume(key: string, now: number = Date.now()): number {
    if (!this.config.enabled) return 0;
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.config.windowMs });
      this.sweep(now);
      return 0;
    }
    bucket.count += 1;
    if (bucket.count > this.config.max) return bucket.resetAt - now;
    return 0;
  }

  /** 惰性清扫：仅当键数量超阈值时清理已过期窗口 */
  private sweep(now: number): void {
    if (this.buckets.size <= 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/** 获取客户端 IP（考虑 X-Forwarded-For 已由 trustProxy 处理后的 request.ip） */
export function clientIp(request: FastifyRequest): string {
  return (request.ip ?? 'unknown').slice(0, 100);
}

/**
 * 路由内限流守卫：未启用时直接放行；超限抛 429（AppError，带 retryAfterSeconds）。
 */
export function enforceRateLimit(limiter: RateLimiter, key: string): void {
  if (!limiter.config.enabled) return;
  const retryAfterMs = limiter.consume(key);
  if (retryAfterMs > 0) {
    throw tooManyRequests(Math.ceil(retryAfterMs / 1000));
  }
}
