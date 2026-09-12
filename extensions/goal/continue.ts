import type { AgentSettledEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearGoalTurnMarks, setGoalRoundPending } from "./auth.js";
import { buildGoalRoundPrompt } from "./prompt.js";
import {
  getActivation,
  nextRevision,
  readSnapshot,
  sessionIdOf,
  writeEvent,
} from "./session.js";
import type { GoalSnapshot } from "./types.js";

type Stop = { stopReason?: string };

const runStops = new Map<string, Stop[]>();
const notifiedMaxRounds = new Set<string>();

function maxRoundsKey(sessionId: string, snapshot: GoalSnapshot): string {
  return `${sessionId}:${snapshot.goalId}:${snapshot.revision}`;
}

export function decideGoalContinuation(input: {
  snapshot: GoalSnapshot | undefined;
  activation: "armed" | "disarmed";
  assistantStops: Stop[];
  alreadyNotifiedMaxRounds: boolean;
}): { action: "none" | "reenter" | "max-rounds"; nextRound?: number } {
  const { snapshot, activation, assistantStops, alreadyNotifiedMaxRounds } = input;
  if (!snapshot || snapshot.status !== "active" || activation !== "armed") {
    return { action: "none" };
  }
  if (assistantStops.some((stop) => stop.stopReason === "aborted" || stop.stopReason === "error")) {
    return { action: "none" };
  }
  if (snapshot.roundsStarted >= snapshot.maxRounds) {
    return { action: alreadyNotifiedMaxRounds ? "none" : "max-rounds" };
  }
  return { action: "reenter", nextRound: snapshot.roundsStarted + 1 };
}

export function recordRunStopReasons(sessionId: string, messages: unknown): void {
  const list = Array.isArray(messages) ? messages : [];
  const stops: Stop[] = [];
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const rec = message as { role?: unknown; stopReason?: unknown };
    if (rec.role !== "assistant") continue;
    stops.push({
      stopReason: typeof rec.stopReason === "string" ? rec.stopReason : undefined,
    });
  }
  runStops.set(sessionId, stops);
}

export function takeRunStopReasons(sessionId: string): Stop[] {
  const stops = runStops.get(sessionId) ?? [];
  runStops.delete(sessionId);
  return stops;
}

export function __resetGoalContinueForTest(): void {
  runStops.clear();
  notifiedMaxRounds.clear();
}

export async function onAgentSettled(
  _event: AgentSettledEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  const sessionId = sessionIdOf(ctx);
  const assistantStops = takeRunStopReasons(sessionId);
  const snapshot = readSnapshot(ctx);
  const activation = getActivation(sessionId);
  const notifyKey = snapshot ? maxRoundsKey(sessionId, snapshot) : "";
  const decision = decideGoalContinuation({
    snapshot,
    activation,
    assistantStops,
    alreadyNotifiedMaxRounds: notifyKey !== "" && notifiedMaxRounds.has(notifyKey),
  });

  if (decision.action === "max-rounds" && snapshot) {
    notifiedMaxRounds.add(maxRoundsKey(sessionId, snapshot));
    ctx.ui.notify("已达轮次上限", "warning");
  }

  clearGoalTurnMarks(sessionId);

  if (decision.action !== "reenter" || decision.nextRound === undefined || !snapshot) {
    return;
  }

  const folded = writeEvent(pi, ctx, {
    kind: "round",
    goalId: snapshot.goalId,
    revision: nextRevision(snapshot),
    at: new Date().toISOString(),
    payload: { round: decision.nextRound },
  });
  if (!folded) return;

  setGoalRoundPending(sessionId, {
    goalId: folded.goalId,
    revision: folded.revision,
    round: folded.roundsStarted,
  });

  await pi.sendMessage(
    {
      customType: "goal-round",
      content: buildGoalRoundPrompt({
        condition: folded.condition,
        round: folded.roundsStarted,
        maxRounds: folded.maxRounds,
      }),
      display: false,
      details: {
        goalId: folded.goalId,
        revision: folded.revision,
        round: folded.roundsStarted,
      },
    },
    { triggerTurn: true },
  );
}
