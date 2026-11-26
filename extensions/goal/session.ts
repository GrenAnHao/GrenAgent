import { projectCwd } from "../_shared/session-cwd.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAutoContinueOnOpen } from "./config.js";
import { revokeGoalRound } from "./auth.js";
import { foldGoal } from "./fold.js";
import { beginGoalOwner, buildGoalStatus, getActivation, setActivation } from "./status.js";
import type { GoalActivation, GoalEvent, GoalSnapshot } from "./types.js";

export { getActivation, setActivation };

type SessionManager = {
  getEntries?: () => unknown[];
  getSessionId?: () => string | undefined;
};

function sessionManager(ctx: ExtensionContext): SessionManager {
  return ctx.sessionManager as SessionManager;
}

export function sessionIdOf(ctx: ExtensionContext): string {
  const sessionId = sessionManager(ctx).getSessionId?.();
  if (!sessionId) throw new Error("SESSION_NOT_BOUND");
  return sessionId;
}

export function readSnapshot(ctx: ExtensionContext): GoalSnapshot | undefined {
  return foldGoal(sessionManager(ctx).getEntries?.() ?? []);
}

export function nextRevision(snapshot: GoalSnapshot | undefined): number {
  return snapshot ? snapshot.revision + 1 : 1;
}

export function newGoalId(): string {
  return crypto.randomUUID();
}

export function writeEvent(pi: ExtensionAPI, ctx: ExtensionContext, event: GoalEvent): GoalSnapshot | undefined {
  pi.appendEntry("goal", event);
  return readSnapshot(ctx);
}

export type StatusSnapshot = (GoalSnapshot & { activation: GoalActivation }) | null;

export function currentStatusSnapshot(ctx: ExtensionContext): StatusSnapshot {
  const snapshot = readSnapshot(ctx);
  if (!snapshot) return null;
  return { ...snapshot, activation: getActivation(sessionIdOf(ctx)) };
}

export function pushStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus("goal", JSON.stringify(buildGoalStatus({
    entries: sessionManager(ctx).getEntries?.() ?? [],
    sessionId: sessionIdOf(ctx),
    workspace: projectCwd(ctx),
  })));
}

function eventAt(): string {
  return new Date().toISOString();
}

export interface GoalControlMetadata {
  operationId: string;
  controlAction: string;
  expectedConditionRevision: number;
  controlRequest?: string;
  expectedRevision?: number;
}

function writeKind(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  kind: GoalEvent["kind"],
  snapshot: GoalSnapshot,
  payload: Record<string, unknown> = {},
  control?: GoalControlMetadata,
): GoalSnapshot | undefined {
  return writeEvent(pi, ctx, {
    kind,
    goalId: snapshot.goalId,
    revision: nextRevision(snapshot),
    at: eventAt(),
    payload: control ? { ...payload, ...control } : payload,
  });
}

export function createGoal(pi: ExtensionAPI, ctx: ExtensionContext, condition: string, maxRounds?: number, control?: GoalControlMetadata): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (current && current.status !== "complete") {
    throw new Error("GOAL_ALREADY_ACTIVE");
  }
  writeEvent(pi, ctx, {
    kind: "create",
    goalId: newGoalId(),
    revision: 1,
    at: eventAt(),
    payload: { ...(maxRounds === undefined ? { condition } : { condition, maxRounds }), ...control },
  });
  setActivation(sessionIdOf(ctx), "armed");
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function editGoal(pi: ExtensionAPI, ctx: ExtensionContext, condition: string, control?: GoalControlMetadata): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  if (current.condition !== condition.trim()) revokeGoalRound(sessionIdOf(ctx));
  writeKind(pi, ctx, "edit", current, { condition }, control);
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function pauseGoal(pi: ExtensionAPI, ctx: ExtensionContext, control?: GoalControlMetadata): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  if (current.status === "active" || (control && current.status === "paused")) {
    revokeGoalRound(sessionIdOf(ctx));
    writeKind(pi, ctx, "pause", current, { pauseReason: { code: "user" } }, control);
  }
  setActivation(sessionIdOf(ctx), "disarmed");
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function resumeGoal(pi: ExtensionAPI, ctx: ExtensionContext, control?: GoalControlMetadata): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  if (current.runRoundsStarted >= current.maxRounds) throw new Error("GOAL_RESTART_REQUIRES_CONTROL");
  if (current.status === "paused" || current.status === "blocked" || (control && current.status === "active")) {
    writeKind(pi, ctx, "resume", current, {}, control);
  }
  setActivation(sessionIdOf(ctx), "armed");
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function restartGoalForControl(pi: ExtensionAPI, ctx: ExtensionContext, control?: GoalControlMetadata): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  if (current.runRoundsStarted < current.maxRounds || current.status === "complete") throw new Error("GOAL_RESTART_NOT_EXHAUSTED");
  revokeGoalRound(sessionIdOf(ctx));
  const written = writeKind(pi, ctx, "restart", current, { runNumber: current.runNumber + 1 }, control);
  if (!written || written.runNumber !== current.runNumber + 1) throw new Error("GOAL_WRITE_FAILED");
  setActivation(sessionIdOf(ctx), "armed");
  pushStatus(ctx);
  return written;
}

export function clearGoal(pi: ExtensionAPI, ctx: ExtensionContext, control?: GoalControlMetadata): void {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  revokeGoalRound(sessionIdOf(ctx));
  writeKind(pi, ctx, "clear", current, {}, control);
  setActivation(sessionIdOf(ctx), "disarmed");
  pushStatus(ctx);
}

export function completeGoal(pi: ExtensionAPI, ctx: ExtensionContext, summary?: string): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  revokeGoalRound(sessionIdOf(ctx));
  writeKind(pi, ctx, "complete", current, summary === undefined ? {} : { summary });
  setActivation(sessionIdOf(ctx), "disarmed");
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function blockGoal(pi: ExtensionAPI, ctx: ExtensionContext, message: string): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  revokeGoalRound(sessionIdOf(ctx));
  writeKind(pi, ctx, "blocked", current, { message });
  setActivation(sessionIdOf(ctx), "disarmed");
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function onSessionStart(ctx: ExtensionContext, options: { forceDisarmed?: boolean; deferStatus?: boolean } = {}): void {
  beginGoalOwner(sessionIdOf(ctx));
  const snapshot = readSnapshot(ctx);
  const armed = !options.forceDisarmed && readAutoContinueOnOpen() && snapshot?.status === "active" && snapshot.runRoundsStarted < snapshot.maxRounds;
  setActivation(sessionIdOf(ctx), armed ? "armed" : "disarmed");
  if (!options.deferStatus) pushStatus(ctx);
}
