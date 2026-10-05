import type { DisplayMessage } from './groupMessages';
import {
  argsLookParallel,
  expandSubAgents,
  followUpAgentId,
  followUpCardStatus,
  mergeFollowUpResult,
  noteSpawnTask,
  resolveSpawnTask,
  startedAgentIds,
} from '../panels/subagentUtils';
import type { NumberedUnit } from './SubAgentGroupInline';

export interface SpawnFollowOverlay {
  result: unknown;
  status: 'running' | 'done' | 'error';
}

export interface SubAgentIndex {
  unitsByMessage: Map<string, NumberedUnit[]>;
  /** 已经并回启动卡片的 wait/status/cancel/remove，不再单独占一行。 */
  hidden: Set<string>;
  /** 启动卡片要改用的跟进结果。等待还在跑时不覆盖，启动卡片自己仍显示运行中。 */
  overlay: Map<string, SpawnFollowOverlay>;
}

interface SpawnOrigin {
  messageId: string;
  single: boolean;
  result: unknown;
}

/** 把每次 spawn_agent 展开成逐个子代理并赋全局连续序号（#N，跨调用累加）。 */
export function computeSubAgentUnits(messages: DisplayMessage[]): SubAgentIndex {
  const unitsByMessage = new Map<string, NumberedUnit[]>();
  const remembered = new Map<string, string>();
  const originByAgent = new Map<string, SpawnOrigin>();
  const hidden = new Set<string>();
  const overlay = new Map<string, SpawnFollowOverlay>();
  let counter = 0;
  for (const msg of messages) {
    if (msg.kind !== 'tool' || msg.toolName !== 'spawn_agent') continue;
    const followId = followUpAgentId(msg.args, msg.result);
    const origin = followId ? originByAgent.get(followId) : undefined;
    if (origin?.single) {
      hidden.add(msg.id);
      if (msg.status === 'running') overlay.delete(origin.messageId);
      else {
        overlay.set(origin.messageId, {
          result: mergeFollowUpResult(origin.result, msg.result),
          status: followUpCardStatus(msg.status, msg.result),
        });
      }
      noteSpawnTask(remembered, msg);
      continue;
    }
    let units = expandSubAgents(msg.id, msg.args, msg.result, msg.status, argsLookParallel(msg.args)).map((unit) => ({
      unit,
      no: ++counter,
    }));
    const followed = resolveSpawnTask(msg.args, msg.result, remembered);
    if (followed) {
      units = units.map((item) => ({ ...item, unit: { ...item.unit, task: followed } }));
    }
    unitsByMessage.set(msg.id, units);
    noteSpawnTask(remembered, msg);
    const ids = startedAgentIds(msg.args, msg.result);
    const single = ids.length <= 1;
    for (const id of ids) {
      if (!originByAgent.has(id)) originByAgent.set(id, { messageId: msg.id, single, result: msg.result });
    }
  }
  return { unitsByMessage, hidden, overlay };
}

/** 提问卡「已答」判定：其后若已出现用户消息，则定格为只读已答态（最后一张未答仍可交互）。 */
export function computeAnsweredQuestions(messages: DisplayMessage[]): Set<string> {
  const answered = new Set<string>();
  let seenUserAfter = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'user') seenUserAfter = true;
    else if (m.kind === 'notice' && m.customType === 'agent-questions' && seenUserAfter) {
      answered.add(m.id);
    }
  }
  return answered;
}
