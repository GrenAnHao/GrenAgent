import type { WikiOperation, WikiRunContext } from './contracts';
import { runFull } from './fullGeneration';
import { runIncremental } from './incremental';
import type { WikiRequestModel } from './sessionRuntime';

export function createWikiExecutor(ports: { requestModel: WikiRequestModel }) {
  return async function executeOperation(operation: WikiOperation, context: WikiRunContext): Promise<void> {
    context.signal.throwIfAborted();
    if (operation.action === 'full' || operation.action === 'regenerate') return runFull(operation, context, ports.requestModel);
    if (operation.action === 'repair') {
      if (context.checkpoints().some(checkpoint => checkpoint.stage === 'incremental-plan' && checkpoint.disposition === 'done')) return runIncremental(operation, context, ports.requestModel);
      return runFull(operation, context, ports.requestModel);
    }
    return runIncremental(operation, context, ports.requestModel);
  };
}
