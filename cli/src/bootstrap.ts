interface SidecarRuntime {
  run(): Promise<void>;
}

export async function bootstrapSidecar(
  loadRuntime: () => Promise<SidecarRuntime>,
): Promise<void> {
  const runtime = await loadRuntime();
  await runtime.run();
}
