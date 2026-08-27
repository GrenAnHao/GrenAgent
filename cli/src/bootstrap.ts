import { captureSensitiveProcessConfig } from "../../extensions/_shared/runtime-config.js";

interface SidecarRuntime {
  run(): Promise<void>;
}

export async function bootstrapSidecar(
  loadRuntime: () => Promise<SidecarRuntime>,
): Promise<void> {
  captureSensitiveProcessConfig();
  const runtime = await loadRuntime();
  await runtime.run();
}
