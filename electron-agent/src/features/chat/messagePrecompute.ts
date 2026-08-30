import type { DisplayMessage } from './groupMessages';
import { expandSubAgents } from '../panels/subagentUtils';
import type { NumberedUnit } from './SubAgentGroupInline';

/** 把每次 spawn_agent 展开成逐个子代理并赋全局连续序号（#N，跨调用累加）。 */
export function computeSubAgentUnits(messages: DisplayMessage[]): Map<string, NumberedUnit[]> {
  const unitsByMessage = new Map<string, NumberedUnit[]>();
  let counter = 0;
  for (const msg of messages) {
    if (msg.kind === 'tool' && msg.toolName === 'spawn_agent') {
      const units = expandSubAgents(msg.id, msg.args, msg.result, msg.status).map((unit) => ({
        unit,
        no: ++counter,
      }));
      unitsByMessage.set(msg.id, units);
    }
  }
  return unitsByMessage;
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
