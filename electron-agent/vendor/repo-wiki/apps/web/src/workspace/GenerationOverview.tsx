import type { ReactNode } from "react";
import type { Run } from "./api";
import { Icon } from "./Icons";
import {
  finiteCount,
  formatTimestamp,
  projectTargetCount,
  type CollectionProject,
  type KnowledgeKind,
} from "./ProjectCollection";
import "./collection.css";
import type { KnowledgeActionInput, RepoWikiKnowledgeSnapshot } from '../../../../../../shared/knowledgeKernelContracts';
import { projectKnowledge, type KnowledgePrimary } from '../../../../../../src/features/repoWiki/knowledgeProjection';
import { KnowledgeActions, KnowledgeRunProgress } from './KnowledgeRunStatus';
import { Button, Divider, Flex, Segmented, Typography, type MenuProps } from 'antd';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

export type GenerationMetrics = {
  total?: number;
  completed?: number;
  failed?: number;
  updatedAt?: string;
  commit?: string;
  status?: string;
};
export type GenerationOverviewProps = {
  project: CollectionProject;
  mode: KnowledgeKind;
  run: Run | null;
  busy: boolean;
  provider: "demo" | "real";
  onLanguage: (language: string) => void;
  onGenerate: () => void;
  onCancel?: () => void;
  languageBusy?: boolean;
  menu?: ReactNode;
  metrics?: GenerationMetrics;
  knowledge?: RepoWikiKnowledgeSnapshot | null;
  onKnowledgeAction?: (action: KnowledgeActionInput['action']) => void;
  onPreviewDraft?: () => void;
  /** antd menu for the host (kernel) layout; the standalone layout keeps `menu`. */
  moreMenu?: MenuProps;
  onNativeOpen?: () => void;
};
const activeStatuses = new Set(["queued", "running", "cancel_requested"]);
const statusLabels: Record<string, string> = {
  completed: "已生成",
  generated: "已生成",
  ready: "已生成",
  queued: "等待生成",
  running: "正在生成",
  cancel_requested: "正在取消",
  failed: "本次生成失败",
  canceled: "已取消",
  interrupted: "生成已中断",
  idle: "未生成",
  ungenerated: "未生成",
};
/** A target overview, distinct from the generated “项目概览” Wiki document. */
export function GenerationOverview({
  project,
  mode,
  run,
  busy,
  provider,
  onLanguage,
  onGenerate,
  onCancel,
  languageBusy,
  menu,
  metrics,
  knowledge,
  onKnowledgeAction,
  onPreviewDraft,
  moreMenu,
  onNativeOpen,
}: GenerationOverviewProps) {
  const native = mode === 'wiki' ? project.knowledge?.wiki : undefined;
  if (native?.engine === 'qoder-wiki-local-v1' && native.native_coverage) {
    const coverage = native.native_coverage;
    return <section className="rw-generation-overview" aria-label="Repo Wiki 原版概览" data-testid="native-wiki-overview">
      <div className="rw-overview-cluster"><Icon name="branch" size={25} /><h2>Repo Wiki 概览</h2>
        <p>qoder-wiki-local-v1 · {coverage.partial ? '部分覆盖' : '完整覆盖'}</p>
        <p>上次文件投影：已发布 {coverage.published} 篇 · 失败 {coverage.failed.length} 篇 · 可阅读 {coverage.readable} 篇（含保留旧文）</p>
        <p>{formatTimestamp(native.updated_at, true)} · {native.native_publication_id}</p>
        <Button type="primary" onClick={onNativeOpen}>查看实时运行与文件投影</Button>
      </div>
    </section>;
  }
  if (knowledge) {
    const view = projectKnowledge(knowledge), task = knowledge.run;
    const title = mode === 'wiki' ? 'Repo Wiki 概览' : '知识卡片概览';
    const updatedAt = formatTimestamp(knowledge.content.updatedAt ? new Date(knowledge.content.updatedAt).toISOString() : project.knowledge?.[mode]?.updated_at, true);
    const admission = knowledge.admission;
    const model = admission.modelDisplayName || admission.modelIdentity || '系统知识模型';
    const language = project.language.toLowerCase().startsWith('en') ? 'en' : 'zh';
    const commitValue = project.knowledge?.[mode]?.identity?.commit ?? project.identity?.commit;
    const commit = typeof commitValue === 'string' && commitValue ? commitValue.slice(0, 8) : undefined;
    const onAction = (kind: KnowledgePrimary['kind']) => kind === 'generate' ? onGenerate() : onKnowledgeAction?.(kind);
    const row = (label: string, value: ReactNode) => <Flex className="rw-state-row" justify="space-between" align="center" gap={16}>
      <Typography.Text type="secondary">{label}</Typography.Text><span className="rw-state-value">{value}</span></Flex>;
    const statusIcon = { completed: <CheckCircle2 size={14} aria-hidden="true" />, pending: <Info size={14} aria-hidden="true" />, partial: <AlertTriangle size={14} aria-hidden="true" />, failed: <AlertTriangle size={14} aria-hidden="true" /> }[view.statusTone];
    return <section className="rw-generation-overview" aria-label={title} data-testid="knowledge-overview" data-revision={task?.revision}>
      <div className="rw-overview-cluster">
        <div className="rw-overview-emblem" aria-hidden="true">
          <span /><span /><span /><span />
          <span className="rw-overview-mark"><Icon name={mode === 'wiki' ? 'branch' : 'layers'} size={25} /></span>
          <span /><span /><span /><span />
        </div>
        <h1>{title}</h1>
        <Flex vertical gap={14} className="rw-state-stack">
          <div className="rw-state-card">
            {view.inFlight ? <>
              <KnowledgeRunProgress view={view} />
              <Divider className="rw-state-divider" />
              {row('语言', language === 'zh' ? '简体中文' : 'English')}
              {!view.activeLabel && view.currentItem && row('当前内容', view.currentItem)}
            </> : <>
              <Flex className="rw-state-row" justify="space-between" align="center" gap={16}>
                <Typography.Text strong>语言</Typography.Text>
                <Segmented className="rw-language-switch" aria-label="生成语言" size="small" value={language}
                  disabled={busy || languageBusy} onChange={value => onLanguage(String(value))}
                  options={[{ label: 'English', value: 'en' }, { label: '简体中文', value: 'zh' }]} />
              </Flex>
              <Divider className="rw-state-divider" />
              {row('生成状态', <span className="rw-state-status" data-status={view.statusTone}>{statusIcon}{view.statusLabel}</span>)}
              {view.filesLabel && row(mode === 'wiki' ? 'Wiki 文件' : '知识卡片', view.filesLabel)}
              {row('更新时间', updatedAt || '-')}
              {commit && row('已更新至', <code>{commit}</code>)}
            </>}
          </div>
          {view.inFlight && <Typography.Text className="rw-state-hint" type="secondary">后台运行，离开页面不受影响，重启应用后自动继续。</Typography.Text>}
          {!view.inFlight && view.hint && <Typography.Text className="rw-state-hint" type={view.statusTone === 'failed' || view.statusTone === 'partial' ? 'danger' : 'secondary'} role="status">{view.hint}</Typography.Text>}
          {admission.state === 'blocked' && <Typography.Text className="rw-state-hint" type="warning" role="status">{admission.message || admission.reasonCode || '知识模型暂不可用，请在设置中配置后重试。'}</Typography.Text>}
          {admission.state === 'preparing' && !task && <Typography.Text className="rw-state-hint" type="secondary">正在确认知识模型…</Typography.Text>}
          <KnowledgeActions view={view} busy={busy || languageBusy} onAction={onAction} moreMenu={view.published ? moreMenu : undefined} />
          {view.hasDraft && <Button type="link" size="small" className="rw-draft-link" onClick={onPreviewDraft}>查看未发布草稿</Button>}
          <Typography.Text type="secondary" className="rw-generation-mode-note">真实模型 · {model} · 发送选定源码，可能产生费用</Typography.Text>
        </Flex>
      </div>
    </section>;
  }
  const snapshot = project.knowledge?.[mode];
  const candidate = run ?? project.runs_by_kind?.[mode] ?? null;
  const target = (candidate as (Run & { target?: KnowledgeKind }) | null)
    ?.target;
  const currentRun = !target || target === mode ? candidate : null;
  const active = !!currentRun && activeStatuses.has(currentRun.status);
  const completed =
    finiteCount(metrics?.completed) ?? projectTargetCount(project, mode);
  const planned =
    mode === "wiki" && Array.isArray(project.plan?.pages)
      ? project.plan.pages.length
      : undefined;
  const total = finiteCount(metrics?.total) ?? planned;
  const successful =
    currentRun?.status === "completed" ||
    (!currentRun && !!snapshot?.last_run?.completed_at);
  const failed =
    finiteCount(metrics?.failed) ??
    finiteCount(currentRun?.result?.failed) ??
    (successful ? 0 : undefined);
  const status =
    metrics?.status ??
    (currentRun && currentRun.status !== "idle"
      ? currentRun.status
      : (completed ?? 0) > 0
        ? "generated"
        : "ungenerated");
  const updated =
    metrics?.updatedAt ??
    snapshot?.updated_at ??
    snapshot?.last_run?.completed_at;
  const commitValue = metrics?.commit ?? snapshot?.identity?.commit;
  const commit =
    typeof commitValue === "string" && commitValue ? commitValue : undefined;
  const title = mode === "wiki" ? "Repo Wiki 概览" : "知识卡片概览";
  const countLabel = mode === "wiki" ? "Wiki 文件" : "知识卡片";
  const progress =
    typeof currentRun?.progress === "number" &&
    Number.isFinite(currentRun.progress)
      ? Math.min(100, Math.max(0, currentRun.progress))
      : undefined;
  const canCancel =
    active &&
    !!onCancel &&
    currentRun?.cancelable !== false &&
    currentRun?.status !== "cancel_requested";
  const effectiveProvider = active
    ? (currentRun?.provider ?? provider)
    : provider;
  return (
    <section className="rw-generation-overview" aria-label={title}>
      <div className="rw-overview-cluster">
        <div className="rw-overview-emblem" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span className="rw-overview-mark">
            <Icon name={mode === "wiki" ? "branch" : "layers"} size={25} />
          </span>
          <span />
          <span />
          <span />
          <span />
        </div>
        <h1>{title}</h1>
        <div className="rw-generation-summary">
          <div className="rw-generation-language">
            <span>语言</span>
            <div
              className="rw-language-switch"
              role="group"
              aria-label="生成语言"
            >
              <button
                type="button"
                aria-pressed={project.language.toLowerCase().startsWith("en")}
                disabled={busy || active || languageBusy}
                onClick={() => onLanguage("en")}
              >
                English
              </button>
              <button
                type="button"
                aria-pressed={project.language.toLowerCase().startsWith("zh")}
                disabled={busy || active || languageBusy}
                onClick={() => onLanguage("zh")}
              >
                简体中文
              </button>
            </div>
          </div>
          <dl>
            <div>
              <dt>生成状态</dt>
              <dd
                className={`rw-generation-status ${status}`}
                aria-live="polite"
              >
                {["generated", "ready", "completed"].includes(status) && (
                  <Icon name="check" size={15} />
                )}{" "}
                {statusLabels[status] ?? status}
              </dd>
            </div>
            <div>
              <dt>{countLabel}</dt>
              <dd>
                {completed === undefined ? (
                  "—"
                ) : (
                  <>
                    {completed}
                    {total !== undefined && total > 0 ? ` / ${total}` : ""}{" "}
                    {mode === "wiki" ? "已保存" : "张"}
                    {failed !== undefined && <>，{failed} 失败</>}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>
                {formatTimestamp(updated, true) ??
                  ((completed ?? 0) > 0 ? "暂无记录" : "尚未生成")}
              </dd>
            </div>
            <div>
              <dt>已更新至</dt>
              <dd>
                {commit ? (
                  <code title={commit}>{commit.slice(0, 8)}</code>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
          {active && (
            <div className="rw-generation-progress" role="status">
              <progress
                aria-label={`${countLabel}生成进度`}
                max={100}
                value={progress}
              />
              <span>{currentRun?.message || "正在分析源码并生成内容…"}</span>
              {(currentRun?.page_id || currentRun?.current_page) && <span>当前文档：{currentRun.page_id || currentRun.current_page}</span>}
            </div>
          )}
        </div>
        <div className="rw-generation-actions">
          <div className="rw-generation-split">
            <button
              type="button"
              className="rw-generate-button"
              title="增量重新生成：复用未变更内容的缓存。全量生成请使用更多菜单。"
              disabled={active ? !canCancel : busy || languageBusy}
              onClick={active ? onCancel : onGenerate}
            >
              {active
                ? currentRun?.status === "cancel_requested"
                  ? "正在取消…"
                  : canCancel
                    ? "取消生成"
                    : "正在生成…"
                : (completed ?? 0) > 0
                  ? "重新生成"
                  : mode === "cards"
                    ? "生成卡片"
                    : "生成文档"}
            </button>
            {menu && <div className="rw-generation-menu">{menu}</div>}
          </div>
        </div>
        <p className="rw-generation-mode-note">
          {effectiveProvider === "demo"
            ? "离线演示 · 不调用大模型"
            : "真实模型 · 发送选定源码，可能产生费用"}
        </p>
        {currentRun &&
          ["failed", "canceled", "interrupted"].includes(currentRun.status) && (
            <p
              className={`rw-generation-notice ${currentRun.status}`}
              role="status"
            >
              {currentRun.error ||
                currentRun.message ||
                "本次任务未完成，已保存的文档仍然保留。"}
            </p>
          )}
      </div>
    </section>
  );
}
export const ProjectOverview = GenerationOverview;
