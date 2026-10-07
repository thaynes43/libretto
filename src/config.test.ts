import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig resolveNoMatchTtlMs', () => {
  it('defaults to 24 hours', () => {
    expect(loadConfig({}).resolveNoMatchTtlMs).toBe(24 * 60 * 60 * 1000);
  });
  it('reads LIBRETTO_RESOLVE_NO_MATCH_TTL_MS, where 0 turns the cache off', () => {
    expect(loadConfig({ LIBRETTO_RESOLVE_NO_MATCH_TTL_MS: '60000' }).resolveNoMatchTtlMs).toBe(
      60000,
    );
    expect(loadConfig({ LIBRETTO_RESOLVE_NO_MATCH_TTL_MS: '0' }).resolveNoMatchTtlMs).toBe(0);
  });
  it('falls back to the default on junk', () => {
    expect(loadConfig({ LIBRETTO_RESOLVE_NO_MATCH_TTL_MS: 'soon' }).resolveNoMatchTtlMs).toBe(
      86_400_000,
    );
    expect(loadConfig({ LIBRETTO_RESOLVE_NO_MATCH_TTL_MS: '-5' }).resolveNoMatchTtlMs).toBe(
      86_400_000,
    );
  });
});
