import { join } from 'node:path';

export function resolveWorkerEntry(input: { packaged: boolean; resourcesPath: string; mainDir: string }): string {
  return input.packaged
    ? join(input.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'pi-worker.js')
    : join(input.mainDir, 'pi-worker.js');
}
