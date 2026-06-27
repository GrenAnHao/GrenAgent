import { memo, useCallback, useState } from 'react';
import { Button, Icon, Modal } from '@lobehub/ui';
import { CheckCircle2, Circle, FileText, ListChecks, Play } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { pi } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { ConvCard } from './conv/ConvCard';
import { LazyMarkdown } from './LazyMarkdown';
import ModelAction from './input/actions/ModelAction';

const styles = createStaticStyles(({ css }) => ({
  title: css`
    padding: 9px 12px 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: ${cssVar.colorText};
  `,
  summary: css`
    padding: 4px 12px 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
  `,
  todos: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
  `,
  todo: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  todoIcon: css`
    margin-block-start: 2px;
    flex: none;
    color: ${cssVar.colorTextQuaternary};
  `,
  todoDone: css`
    color: ${cssVar.colorTextTertiary};
    text-decoration: line-through;
  `,
  more: css`
    padding: 2px 12px 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  right: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  docError: css`
    font-size: 13px;
    color: ${cssVar.colorTextTertiary};
  `,
  fallback: css`
    padding: 10px 12px;
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
  `,
}));

interface PlanTodo {
  text: string;
  done?: boolean;
}

interface PlanData {
  kind: 'plan';
  id: string;
  title: string;
  summary: string;
  todos: PlanTodo[];
  planFile: string;
  status?: 'draft' | 'executing' | 'done';
}

const PREVIEW_COUNT = 3;

/** content 为 agent-mode 写入的 PlanCardData JSON；非本结构返回 null（调用方回退）。 */
export function parsePlan(content: string): PlanData | null {
  try {
    const d = JSON.parse(content) as Partial<PlanData>;
    if (d && d.kind === 'plan' && typeof d.title === 'string' && Array.isArray(d.todos)) {
      return {
        kind: 'plan',
        id: String(d.id ?? ''),
        title: d.title,
        summary: String(d.summary ?? ''),
        todos: d.todos.map((t) => ({ text: String(t?.text ?? ''), done: Boolean(t?.done) })),
        planFile: String(d.planFile ?? ''),
        status: d.status,
      };
    }
  } catch {
    /* not our JSON */
  }
  return null;
}

/**
 * 对话流内的「计划摘要卡」（L4，ConvCard surface）：标题 + 摘要 + todo 预览，
 * 底部 View Plan 看完整计划、选执行模型、开始执行。解析失败回退纯文本。
 */
export const PlanCard = memo(function PlanCard({ content }: { content: string }) {
  const { workspace } = useAgentStoreContext();
  const data = parsePlan(content);
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<string | null>(null);
  const [docError, setDocError] = useState(false);
  const [built, setBuilt] = useState(false);

  const openPlan = useCallback(async () => {
    setOpen(true);
    if (doc !== null || !data?.planFile) return;
    try {
      setDoc(await pi.readFile(workspace, data.planFile));
    } catch {
      setDocError(true);
    }
  }, [doc, data?.planFile, workspace]);

  const onBuild = useCallback(async () => {
    setBuilt(true);
    try {
      await pi.runCommand(workspace, '/plan-build');
    } catch {
      setBuilt(false);
    }
  }, [workspace]);

  if (!data) {
    return (
      <ConvCard label="Plan" icon={ListChecks} data-testid="plan-card">
        <div className={styles.fallback}>{content}</div>
      </ConvCard>
    );
  }

  const shown = data.todos.slice(0, PREVIEW_COUNT);
  const more = data.todos.length - shown.length;

  return (
    <ConvCard
      label="Plan"
      icon={ListChecks}
      tag={`${data.todos.length} steps`}
      data-testid="plan-card"
      footer={
        <>
          <Button icon={<FileText size={14} />} onClick={openPlan} size="small">
            View Plan
          </Button>
          <div className={styles.right}>
            <ModelAction />
            <Button
              disabled={built}
              icon={<Play size={14} />}
              onClick={onBuild}
              size="small"
              type="primary"
            >
              {built ? '执行中' : '开始执行'}
            </Button>
          </div>
        </>
      }
    >
      <div className={styles.title}>{data.title}</div>
      {data.summary ? <div className={styles.summary}>{data.summary}</div> : null}

      <div className={styles.todos}>
        {shown.length > 0 ? (
          shown.map((t, i) => (
            <div className={styles.todo} key={i}>
              <Icon className={styles.todoIcon} icon={t.done ? CheckCircle2 : Circle} size={14} />
              <span className={t.done ? styles.todoDone : undefined}>{t.text || '（未命名步骤）'}</span>
            </div>
          ))
        ) : (
          <div className={styles.more}>计划步骤将在执行阶段由模型补充</div>
        )}
        {more > 0 ? <div className={styles.more}>+{more} 个步骤…</div> : null}
      </div>

      <Modal footer={null} onCancel={() => setOpen(false)} open={open} title={data.title} width={760}>
        {docError ? (
          <div className={styles.docError}>计划文件读取失败（{data.planFile}）。</div>
        ) : doc === null ? (
          <div className={styles.docError}>加载中…</div>
        ) : (
          <LazyMarkdown>{doc}</LazyMarkdown>
        )}
      </Modal>
    </ConvCard>
  );
});
