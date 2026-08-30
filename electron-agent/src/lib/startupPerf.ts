const PREFIX = '[PERF-startup]';

/** Dev-only startup timing helper. Logs labeled durations to the console. */
export function createStartupPerf(scope: string) {
  const marks = new Map<string, number>();
  const results: Array<{ label: string; ms: number }> = [];

  const start = (label: string) => {
    marks.set(label, performance.now());
  };

  const end = (label: string) => {
    const t0 = marks.get(label);
    if (t0 == null) return;
    const ms = Math.round(performance.now() - t0);
    results.push({ label, ms });
    marks.delete(label);
    if (import.meta.env.DEV) {
      console.info(`${PREFIX} ${scope}/${label}: ${ms}ms`);
    }
  };

  const report = () => {
    if (!import.meta.env.DEV || results.length === 0) return;
    const summary = results.map((r) => `${r.label}=${r.ms}ms`).join(', ');
    console.info(`${PREFIX} ${scope} total: ${summary}`);
  };

  return { start, end, report };
}
