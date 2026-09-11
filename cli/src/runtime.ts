import { main } from "@earendil-works/pi-coding-agent";
import { allExtensions, safety } from "../../extensions/index.js";

function emitReadyBanner(): void {
  const safetyOn = allExtensions.includes(safety);
  console.error(`[grenagent-sidecar] ready ext=${allExtensions.length} safety=${safetyOn ? "on" : "OFF"}`);
}

function onPipeError(err: NodeJS.ErrnoException | undefined): void {
  if (err?.code === "EPIPE") process.exit(0);
}
process.stdout.on("error", onPipeError);
process.stderr.on("error", onPipeError);
process.on("uncaughtException", onPipeError);
process.on("unhandledRejection", (reason) => onPipeError(reason as NodeJS.ErrnoException));

export async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  emitReadyBanner();
  await main(argv, { extensionFactories: allExtensions });
}
