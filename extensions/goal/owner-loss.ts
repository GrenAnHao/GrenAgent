import type { ConfirmedGoalOwnerLoss, GoalWorkslotNotice } from '../../electron-agent/electron/agentProcess/contract.js';

export interface GoalOwnerLossPort {
  publish(notice: GoalWorkslotNotice): void;
  claim(sessionPath: string, sessionId: string): Promise<ConfirmedGoalOwnerLoss | undefined>;
  ack(loss: ConfirmedGoalOwnerLoss): Promise<boolean>;
}

// The extension loader and the host import can instantiate separate modules in
// the same process. The host installs this port; model tools cannot install it.
const PORT_KEY = Symbol.for('gren.goal.owner-loss-port');
function slot(): Record<symbol, GoalOwnerLossPort | undefined> {
  return globalThis as unknown as Record<symbol, GoalOwnerLossPort | undefined>;
}
export function installGoalOwnerLossPort(port: GoalOwnerLossPort | undefined): void { slot()[PORT_KEY] = port; }
export function goalOwnerLossPort(): GoalOwnerLossPort | undefined { return slot()[PORT_KEY]; }
