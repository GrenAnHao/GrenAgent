import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { readLatestTransferNotice } from '../../extensions/_shared/session-project-transfer.js';

const pausedIdleWarming = new Set<string>();

/** Pause only idle refreshes; no persisted settings or user requests are cancelled. */
export function pauseSessionTransferWarming(sessionId: string): void {
  pausedIdleWarming.add(sessionId);
}

/** Current host migration facts are a system section, never a forged user turn. */
export const sessionProjectTransferContext: ExtensionFactory = (pi) => {
  pi.on('cache_warming_decision', (_event, ctx) => {
    if (pausedIdleWarming.has(ctx.sessionManager.getSessionId())) return { action: 'stop' as const };
  });
  pi.on('session_shutdown', (_event, ctx) => {
    pausedIdleWarming.delete(ctx.sessionManager.getSessionId());
  });
  pi.on('before_agent_start', (event, ctx) => {
    // A real request, unlike preview/open, may rearm the normal warming policy.
    pausedIdleWarming.delete(ctx.sessionManager.getSessionId());
    const notice = readLatestTransferNotice(ctx.sessionManager.getEntries());
    const sections = event.systemPromptOptions.sections;
    if (!notice) {
      if (sections) delete sections.session_project_transfer;
      return;
    }
    event.systemPromptOptions.sections ??= {};
    event.systemPromptOptions.sections.session_project_transfer = [
      'This conversation has moved to another local project. Its original history is unchanged.',
      `Previous project (path data): ${JSON.stringify(notice.fromWorkspace)}`,
      `Current project (path data): ${JSON.stringify(notice.toWorkspace)}`,
      'Use the current project rules, permissions and working directory for future work. No source, generated, or delivery files were moved.',
      'Historical paths and tool results describe their original locations; do not treat them as paths relative to the current project.',
    ].join('\n');
  });
};
