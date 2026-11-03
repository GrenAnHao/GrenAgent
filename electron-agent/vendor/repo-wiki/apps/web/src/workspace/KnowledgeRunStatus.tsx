import { Button, Dropdown, Flex, Progress, Typography, theme, type MenuProps } from 'antd';
import { AlertTriangle, LoaderCircle, MoreHorizontal, PauseCircle } from 'lucide-react';
import type { KnowledgeActionInput, RepoWikiKnowledgeSnapshot } from '../../../../../../shared/knowledgeKernelContracts';
import { projectKnowledge, type KnowledgePrimary } from '../../../../../../src/features/repoWiki/knowledgeProjection';
import { KnowledgeActiveItems } from '../../../../../../src/features/repoWiki/KnowledgeActiveItems';

type View = ReturnType<typeof projectKnowledge>;
export type KnowledgeActionHandler = (action: KnowledgePrimary['kind']) => void;

/** Stage title, description and progress of a live run — one block for the overview card and the reader banner. */
export function KnowledgeRunProgress({ view, compact }: { view: View; compact?: boolean }) {
  const { token } = theme.useToken();
  const paused = view.runLabel === '已暂停' || view.runLabel === '暂停中';
  const attention = view.runLabel === '需要处理';
  const icon = attention ? <AlertTriangle size={15} color={token.colorWarning} aria-hidden="true" />
    : paused ? <PauseCircle size={15} color={token.colorTextSecondary} aria-hidden="true" />
      : <LoaderCircle size={15} className="rw-spin" color={token.colorPrimary} aria-hidden="true" />;
  return <Flex vertical gap={compact ? 4 : 8} className="rw-run-progress" data-testid="knowledge-run-progress">
    <Flex align="center" gap={6}>
      {icon}
      <Typography.Text strong aria-live="polite">{view.title}</Typography.Text>
      {compact && view.progress !== undefined && <Typography.Text type="secondary" className="rw-tabular">{view.progress}%</Typography.Text>}
    </Flex>
    <Typography.Text type="secondary" className="rw-run-description">{view.description}</Typography.Text>
    <KnowledgeActiveItems view={view} />
    {view.progress !== undefined && !compact && <Progress percent={view.progress} showInfo={false} size="small" aria-label="知识构建进度" />}
  </Flex>;
}

/** Qoder-style actions: one primary (+ joined "more" menu when settled), or primary + cancel while running. */
export function KnowledgeActions({ view, busy, onAction, moreMenu, size = 'middle' }: {
  view: View; busy?: boolean; onAction: KnowledgeActionHandler; moreMenu?: MenuProps; size?: 'small' | 'middle';
}) {
  const disabled = busy || view.submitting;
  const primary = view.primary && <Button type="primary" size={size} autoInsertSpace={false}
    data-knowledge-action={view.primary.kind} disabled={disabled || view.primaryDisabled} onClick={() => onAction(view.primary!.kind)}>{view.primary.label}</Button>;
  if (view.inFlight) {
    if (!primary && !view.secondary) return null;
    return <Flex gap={8} className={`rw-run-actions ${size}`}>
      {primary}
      {view.secondary && <Button size={size} autoInsertSpace={false} data-knowledge-action="cancel" disabled={disabled} onClick={() => onAction('cancel')}>{view.secondary.label}</Button>}
    </Flex>;
  }
  return <div className="rw-generate-group" data-testid="knowledge-primary">
    {primary}
    {moreMenu && <Dropdown menu={moreMenu} trigger={['click']} placement="bottomRight">
      <Button type="primary" aria-label="更多 Wiki 操作" icon={<MoreHorizontal size={15} aria-hidden="true" />} />
    </Dropdown>}
  </div>;
}

/** Compact status above a document while a run is live or failed. */
export function KnowledgeRunBanner({ knowledge, busy, onAction }: { knowledge: RepoWikiKnowledgeSnapshot; busy?: boolean; onAction: (action: KnowledgeActionInput['action']) => void }) {
  const view = projectKnowledge(knowledge);
  if (!knowledge.run || (!view.inFlight && knowledge.run.state !== 'failed')) return null;
  return <div className="rw-run-banner" data-testid="knowledge-run-banner">
    {view.inFlight ? <KnowledgeRunProgress view={view} compact />
      : <Flex align="center" gap={6}><AlertTriangle size={15} className="rw-danger" aria-hidden="true" /><Typography.Text type="danger">{view.hint}</Typography.Text></Flex>}
    {view.inFlight && <KnowledgeActions view={view} busy={busy} size="small" onAction={kind => kind !== 'generate' && onAction(kind)} />}
  </div>;
}
