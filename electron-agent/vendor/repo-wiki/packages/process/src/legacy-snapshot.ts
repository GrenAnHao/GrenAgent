/** Keep the audited synchronous migration algorithm off the service IPC thread. */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { migrateWorkspace } from "../../core/src/migration.js";
import { WorkspaceError, type MigrationResult } from "../../core/src/engine.js";
import { ContractError } from "../../contracts/src/index.js";

type SnapshotReply =
  | { ok: true; result: MigrationResult }
  | { ok: false; error: { message: string; status: number } };

/** Called by the same bundled entry before constructing the normal service. */
export function runLegacySnapshotWorker(): boolean {
  if (isMainThread || workerData?.kind !== "legacy-snapshot") return false;
  let reply: SnapshotReply;
  try {
    if (typeof workerData.from !== "string" || typeof workerData.to !== "string") throw new ContractError("Invalid legacy snapshot paths");
    reply = { ok: true, result: migrateWorkspace(workerData.from, workerData.to) };
  } catch (error) {
    reply = { ok: false, error: error instanceof WorkspaceError || error instanceof ContractError
      ? { message: error.message.slice(0, 500), status: error.status }
      : { message: "Legacy snapshot failed; original data was preserved", status: 500 } };
  }
  parentPort?.postMessage(reply);
  parentPort?.close();
  return true;
}

export function snapshotLegacyInWorker(entry: string, from: string, to: string, signal?: AbortSignal): Promise<MigrationResult> {
  if (signal?.aborted) return Promise.reject(new ContractError("Legacy snapshot canceled", 499));
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, { workerData: { kind: "legacy-snapshot", from, to }, trackUnmanagedFds: true });
    let reply: SnapshotReply | undefined, failed = false, aborted = false, settled = false;
    const finish = (error?: Error, result?: MigrationResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
      error ? reject(error) : resolve(result!);
    };
    const abort = () => {
      if (aborted || settled) return;
      aborted = true;
      // Do not let core's finally remove the staging directory while Windows
      // still has native SQLite/file handles open in the migration worker.
      void worker.terminate().then(
        () => finish(new ContractError("Legacy snapshot canceled", 499)),
        () => finish(new ContractError("Legacy snapshot cancellation failed", 500)),
      );
    };
    worker.on("message", (message: SnapshotReply) => { reply = message; });
    worker.once("error", () => { failed = true; });
    worker.once("exit", code => {
      if (aborted) return; // terminate() must finish before the rejection.
      if (failed || code !== 0 || !reply) return finish(new ContractError("Legacy snapshot worker failed; original data was preserved", 500));
      if (reply.ok) finish(undefined, reply.result);
      else finish(new ContractError(reply.error.message, reply.error.status));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
