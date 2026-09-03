export interface ShutdownTarget {
  name: string;
  shutdown(): Promise<void>;
}

export interface ShutdownRegistry {
  killAll(): Promise<void>;
}

export async function shutdownAll(
  targets: ShutdownTarget[],
  registry: ShutdownRegistry,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const graceful = Promise.allSettled(targets.map((target) => target.shutdown()));
  await Promise.race([graceful, sleep(timeoutMs)]);
  // Services that stopped cleanly already unregistered their children, so
  // this only escalates for whatever survived past the grace window.
  await registry.killAll();
}
