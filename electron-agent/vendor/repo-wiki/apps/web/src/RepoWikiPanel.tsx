/**
 * Host-contained Repo Wiki document panel. No browser-route ownership.
 * Size the host (height: 100% or an explicit height); optional CSS variables
 * --repo-wiki-background/foreground/sidebar/accent adapt to GrenAgent's theme.
 */
import type { CSSProperties } from "react";
import App from "./App";
import "./index.css";
import type { RepoWikiClient } from "./workspace/api";
import type { HostProjectSummary } from '../../../packages/contracts/src/host';
import type { Project } from './workspace/api';
import type { KnowledgeActivity } from '../../../../../src/features/repoWiki/knowledgeProjection';
export type RepoWikiHostContext = {
  key: string;
  contextId?: string;
  projectId: string | null;
  status: 'bound' | 'pending' | 'empty';
  projects: HostProjectSummary[];
  currentSummary?: HostProjectSummary;
  project?: Project;
  onLanguage?: (language: string) => Promise<void>;
  revision: number;
  error?: string;
  onRetry?: () => void;
  /** Live generation state per workspace path (see knowledgeActivityKey), from the host task list. */
  activity?: Record<string, KnowledgeActivity>;
};
export interface RepoWikiPanelProps {
  client: RepoWikiClient;
  className?: string;
  style?: CSSProperties;
  workspacePath?: string;
  hostContext?: RepoWikiHostContext;
  onSelectWorkspace?: (path: string, projectId?: string) => Promise<void>;
  onClose?: () => void;
  registerNavigationGuard?: (guard: () => boolean) => () => void;
  visible?: boolean;
  integrated?: boolean;
  onOpenTasks?: () => void;
}
export function RepoWikiPanel({
  client,
  className = "",
  style,
  workspacePath,
  hostContext,
  onSelectWorkspace,
  onClose,
  registerNavigationGuard,
  visible = true,
  integrated = false,
  onOpenTasks,
}: RepoWikiPanelProps) {
  return (
    <div className={`repo-wiki-panel ${className}`.trim()} style={style}>
      <App client={client} syncLocation={false} workspacePath={workspacePath}
        onClose={onClose} registerNavigationGuard={registerNavigationGuard}
        hostContext={hostContext} onSelectWorkspace={onSelectWorkspace} visible={visible} integrated={integrated} onOpenTasks={onOpenTasks} />
    </div>
  );
}
