import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MemoryClient } from '../memory/client.js';
import { currentWorkspaceContext, resolveToolOrigin } from '../_shared/workspace-context.js';
import { getConfig } from '../_shared/runtime-config.js';

interface GoalInputContext {
  source: 'interactive' | 'rpc' | 'extension';
  text: string;
}

const inputs = new Map<string, GoalInputContext>();

function inputKey(): string {
  return currentWorkspaceContext()?.workspace ?? process.cwd();
}

export function setGoalInputContext(source: GoalInputContext['source'], text: string): void {
  inputs.set(inputKey(), { source, text });
}

export function clearGoalInputContext(): void {
  inputs.delete(inputKey());
}

/** 仅测试：清空全部分键，避免 afterEach 依赖当前 ALS。 */
export function __resetGoalInputForTest(): void {
  inputs.clear();
}

function currentInput(): GoalInputContext | undefined {
  return inputs.get(inputKey());
}

function automaticTurn(): boolean {
  const origin = resolveToolOrigin();
  if (origin === 'goal' || origin === 'subagent') return true;
  // sidecar 双栈回退：第 3/5 份删 Goal sidecar 与 system worker 之前，worker 仍靠 env。
  return process.env.PI_GOAL_WORKER === '1' || process.env.PI_SYSTEM_WORKER === '1';
}

function trustedHumanOrigin(): boolean {
  const origin = process.env.PI_TURN_ORIGIN ?? process.env.PI_INPUT_ORIGIN ?? process.env.PI_GOAL_ORIGIN;
  return origin === 'human' || origin === 'human-ui' || getConfig('PI_HUMAN_ORIGIN_TOKEN') === '1';
}

const condition = Type.String({ minLength: 1, maxLength: 4000 });
const revision = Type.Integer({ minimum: 1 });
const goalRef = Type.Object({ goalId: Type.String({ minLength: 1 }), revision });

function session(ctx: ExtensionContext): { sessionId: string; workspace: string } {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) throw new Error('SESSION_NOT_BOUND');
  return { sessionId, workspace: ctx.cwd };
}

function hasContinuousIntent(text: string): boolean {
  return /(?:持续|直到完成|完成后再停止|keep going|until complete|continuous|\/goal\b)/i.test(text);
}

function userTurnRequired(): void {
  if (automaticTurn() || !trustedHumanOrigin()) throw new Error('GOAL_CREATE_FORBIDDEN');
  const input = currentInput();
  if (input) {
    if (input.source === 'extension') throw new Error('GOAL_CREATE_FORBIDDEN');
    if (!hasContinuousIntent(input.text)) throw new Error('GOAL_CREATE_INTENT_REQUIRED');
  }
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: value === undefined ? 'null' : JSON.stringify(value) }], details: value };
}

function validateSnapshot(
  value: unknown,
  scopeRef: { sessionId: string; workspace: string },
  expected?: { goalId: string; revision: number },
  options: { initialRevision?: boolean; allowSameRevision?: boolean } = {},
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_GOAL_RESPONSE');
  const snapshot = value as { sessionId?: unknown; workspace?: unknown; goalId?: unknown; revision?: unknown };
  const revision = snapshot.revision;
  if (snapshot.sessionId !== scopeRef.sessionId || snapshot.workspace !== scopeRef.workspace) throw new Error('GOAL_SCOPE_MISMATCH');
  if (typeof snapshot.goalId !== 'string' || !snapshot.goalId.trim() || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new Error('INVALID_GOAL_RESPONSE');
  if (options.initialRevision && revision !== 1) throw new Error('INVALID_GOAL_RESPONSE');
  if (expected && (snapshot.goalId !== expected.goalId || (options.allowSameRevision ? ![expected.revision, expected.revision + 1].includes(revision) : revision !== expected.revision + 1))) throw new Error('VERSION_CONFLICT');
  return value;
}

export function registerGoalTools(pi: ExtensionAPI, client = new MemoryClient()): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== 'function') return;
  pi.registerTool({
    name: 'get_goal', label: 'Get Goal', description: 'Read the Goal for the current session.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const ref = session(ctx);
      const value = await client.request('goal.get', ref);
      return result(value === undefined ? undefined : validateSnapshot(value, ref));
    },
  });
  pi.registerTool({
    name: 'create_goal', label: 'Create Goal', description: 'Create a session Goal for continuous work.',
    parameters: Type.Object({ condition, continuousIntentEvidence: Type.String({ minLength: 1, maxLength: 4000 }), maxRounds: Type.Optional(revision) }),
    async execute(_id, params, _signal, _update, ctx) {
      userTurnRequired();
      if (typeof params.condition !== 'string' || params.condition.length === 0 || params.condition.length > 4000) throw new Error('INVALID_PARAMS');
      if (typeof params.continuousIntentEvidence !== 'string' || params.continuousIntentEvidence.length === 0 || params.continuousIntentEvidence.length > 4000) throw new Error('INVALID_PARAMS');
      if (!hasContinuousIntent(params.continuousIntentEvidence)) throw new Error('GOAL_CREATE_INTENT_REQUIRED');
      const ref = session(ctx);
      const value = await client.request('goal.create', { ...ref, condition: params.condition, continuousIntentEvidence: params.continuousIntentEvidence, ...(params.maxRounds === undefined ? {} : { maxRounds: params.maxRounds }) });
      return result(validateSnapshot(value, ref, undefined, { initialRevision: true }));
    },
  });
  pi.registerTool({
    name: 'update_goal', label: 'Update Goal', description: 'Report allowed progress for the current session Goal.',
    parameters: Type.Object({ ...goalRef.properties, action: Type.Union([Type.Literal('block'), Type.Literal('begin_judging')]), summary: Type.Optional(Type.String({ maxLength: 4000 })), fingerprint: Type.Optional(Type.String({ maxLength: 400 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const ref = session(ctx);
      if (!automaticTurn() && params.action !== 'block' && params.action !== 'begin_judging') throw new Error('INVALID_GOAL_ACTION');
      const value = await client.request('goal.update', { ...ref, goalId: params.goalId, revision: params.revision, action: params.action, payload: { reason: params.summary, fingerprint: params.fingerprint } });
      return result(validateSnapshot(value, ref, { goalId: params.goalId, revision: params.revision }, { allowSameRevision: params.action === 'block' }));
    },
  });
  pi.registerTool({
    name: 'request_goal_completion', label: 'Request Goal Completion', description: 'Ask the independent coordinator to judge the current Goal.',
    parameters: Type.Object({ ...goalRef.properties, evidence: Type.Optional(Type.String({ maxLength: 32000 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const ref = session(ctx);
      const value = await client.request('goal.requestCompletion', {
        ...ref,
        goalId: params.goalId,
        revision: params.revision,
        action: 'begin_judging',
        ...(params.evidence === undefined ? {} : { payload: { evidence: params.evidence } }),
      });
      return result(validateSnapshot(value, ref, { goalId: params.goalId, revision: params.revision }));
    },
  });
}
