// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
export function createLogger(_name: string) {
  return { info(..._args: unknown[]) {}, warn(..._args: unknown[]) {}, error(..._args: unknown[]) {}, debug(..._args: unknown[]) {} };
}
