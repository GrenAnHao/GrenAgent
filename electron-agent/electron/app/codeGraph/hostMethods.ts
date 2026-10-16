import type { IndexProgress } from '@colbymchenry/codegraph';
import type { CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { MethodHandler } from '../../agentProcess/rpcPeer';
import type { CodeGraphService } from './codeGraphService';
import type { CodeGraphHostMethod } from './hostContract';

type Engine = Pick<CodeGraphService, 'status' | 'call' | 'search' | 'runSync' | 'cancelSync'>;

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string') throw new Error(`codegraph-host: ${key} must be a string`);
  return value;
}

/**
 * 子进程一侧的处理表：把 RPC 原样转给同一个 CodeGraphService。语义（读写互斥、取消、空闲回收、
 * 错误文案）全部留在 CodeGraphEngine 里，这一层只做参数还原和进度回传。
 */
export function createCodeGraphHostMethods(
  engine: Engine,
  onProgress: (jobId: string, progress: IndexProgress) => void,
  tracker: { active: Set<string> } = { active: new Set() },
): Record<CodeGraphHostMethod, MethodHandler> {
  return {
    'codegraph.status': (p) => engine.status(str(p, 'workspace')),
    'codegraph.call': (p) => engine.call(str(p, 'workspace'), str(p, 'tool') as CodeRetrievalTool,
      p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args as Record<string, unknown> : {}),
    'codegraph.search': (p) => engine.search(str(p, 'workspace'), str(p, 'query'), typeof p.limit === 'number' ? p.limit : 20),
    'codegraph.runSync': async (p) => {
      const jobId = str(p, 'jobId');
      tracker.active.add(jobId);
      try {
        await engine.runSync(jobId, str(p, 'workspace'), (progress) => onProgress(jobId, progress));
        return null;
      } finally {
        tracker.active.delete(jobId);
      }
    },
    'codegraph.cancelSync': async (p) => { await engine.cancelSync(str(p, 'jobId')); return null; },
  };
}
