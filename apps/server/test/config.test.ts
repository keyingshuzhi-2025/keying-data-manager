import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('parses trust proxy values without turning false into a string', () => {
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ TRUST_PROXY: '127.0.0.1' }).trustProxy).toBe('127.0.0.1');
  });

  it('requires explicit, non-trivial production credentials', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/ADMIN_USERNAME/);
    expect(() => loadConfig({
      NODE_ENV: 'production',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'short',
    })).toThrow(/at least 12 bytes/);
  });
});
