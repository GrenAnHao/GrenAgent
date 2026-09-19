import type { ChatMessage } from '../../stores/agentReducer';
import type { ReviewPayload } from '../../stores/dockStore';
import { fileDiffModel, mutationPath, type FileDiff } from '../tools/fileDiffModel';
import { groupMessages } from './groupMessages';
import { changesForTurn, type ChangeFile } from './turnDeliverables';

export type ReviewKind = 'empty' | 'missing' | 'none' | 'unavailable' | 'ready';
export type ReviewView =
  | { kind: 'empty' }
  | { kind: 'missing' }
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; files: ChangeFile[]; selected: number; hunks: FileDiff[] };

export function reviewView(messages: ChatMessage[], payload: ReviewPayload): ReviewView {
  if (!payload.turnId) return { kind: 'empty' };
  const grouped = groupMessages(messages);
  const turn = grouped.find((item) => item.kind === 'turn' && item.id === payload.turnId);
  if (!turn || turn.kind !== 'turn') return { kind: 'missing' };
  const files = changesForTurn(turn.segments);
  if (files.length === 0) return { kind: 'none' };
  const raw = payload.fileIndex ?? 0;
  const selected = raw >= 0 && raw < files.length ? raw : 0;
  const path = files[selected].path;
  const hunks = turn.segments.flatMap((segment) => {
    if (segment.kind !== 'tool' || segment.status !== 'done') return [];
    const diff = fileDiffModel(segment.toolName, segment.args, segment.result, segment.status);
    return diff && mutationPath(segment.args) === path ? [diff] : [];
  });
  if (hunks.length === 0) return { kind: 'unavailable' };
  return { kind: 'ready', files, selected, hunks };
}
