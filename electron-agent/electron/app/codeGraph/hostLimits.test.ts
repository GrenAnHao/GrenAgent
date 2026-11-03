import { describe, expect, it } from 'vitest';
import { applyHostLimits, defaultParseWorkers, rssLimitBytes } from './hostLimits';

describe('hostLimits', () => {
  it('caps parse workers at two and derives the rss ceiling from the environment', () => {
    expect(defaultParseWorkers(1)).toBe(1);
    expect(defaultParseWorkers(4)).toBe(1);
    expect(defaultParseWorkers(8)).toBe(2);
    expect(defaultParseWorkers(32)).toBe(2);
    expect(rssLimitBytes(undefined)).toBe(3072 * 1_048_576);
    expect(rssLimitBytes('0')).toBe(0);
    expect(rssLimitBytes('nope')).toBe(3072 * 1_048_576);
  });

  it('sets the parse-worker count once and ignores a rejected flag', () => {
    const env: NodeJS.ProcessEnv = {};
    const flags: string[] = [];
    applyHostLimits({
      env,
      cores: 8,
      pid: 1,
      setPriority: () => { throw new Error('denied'); },
      setFlags: (flag) => { flags.push(flag); if (flag.includes('liftoff')) throw new Error('rejected'); },
    });
    expect(env.CODEGRAPH_PARSE_WORKERS).toBe('2');
    expect(flags).toEqual(['--liftoff-only', '--max-old-space-size=2048']);
    applyHostLimits({ env, cores: 8, pid: 1, setPriority: () => undefined, setFlags: () => undefined });
    expect(env.CODEGRAPH_PARSE_WORKERS).toBe('2');
  });
});