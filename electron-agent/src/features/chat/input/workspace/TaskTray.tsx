import { useCallback, useEffect, useState } from 'react';
import { ActionIcon, Icon, Popover } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx, keyframes } from 'antd-style';
import { AlertTriangle, CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import { onPiEvent, pi, type SubAgentItem } from '../../../../lib/pi';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { wsStyles as s } from './styles';

const spin = keyframes`
  to { transform: rotate(360deg); }
`;

const t = createStaticStyles(({ css }) => ({
  panel: css`
    scrollbar-width: thin;
    overflow-y: auto;

    width: 330px;
    max-height: 360px;
    margin: -4px;
    padding: 4px;
  `,
  task: css`
    display: flex;
    gap: 10px;
    align-items: center;

    padding: 9px 10px;
    border-radius: 8px;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  body: css`
    flex: 1;
    min-width: 0;
  `,
  t1: css`
    overflow: hidden;
    font-size: 13px;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  t2: css`
    margin-top: 2px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  spin: css`
    flex: none;
    color: ${cssVar.colorSuccess};
    animation: ${spin} 1s linear infinite;
  `,
  st: css`
    flex: none;
    padding: 2px 8px;
    border-radius: 9px;
    font-size: 11px;
    font-weight: 600;
  `,
}));

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  done: '完成',
  error: '失败',
  cancelled: '已取消',
};

function statusColor(status: string): { fg: string; bg: string } {
  if (status === 'running') return { fg: cssVar.colorSuccess, bg: cssVar.colorSuccessBg };
  if (status === 'error') return { fg: cssVar.colorError, bg: cssVar.colorErrorBg };
  return { fg: cssVar.colorTextSecondary, bg: cssVar.colorFillSecondary };
}

function elapsed(from: number, to: number): string {
  const sec = Math.max(0, Math.floor((to - from) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// running 行超过这么久没有心跳（updatedAt 不再前进）就视为「停滞」：时间按最后一次心跳封顶、
// 不再随当前时刻累加，避免后端僵尸 running 行让托盘显示离谱的累计时长。
const STALE_MS = 120_000;
// 自动后台任务到终态后，在托盘里保留这么久即淡出，
// 不长期常驻——它们的结果另有 NoticePill 通知。
const FADE_MS = 60_000;

function isTerminal(status: string): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

// 自动触发的后台任务：runner 把 profile 记为 { source: "auto" }；解析失败时按 task 名前缀兜底。
function isAutoTask(task: SubAgentItem): boolean {
  if (task.profile) {
    try {
      const parsed = JSON.parse(task.profile) as { source?: string };
      if (parsed?.source === 'auto') return true;
    } catch {
      /* profile 不是预期 JSON，落到名称兜底 */
    }
  }
  return /^Auto\s/.test(task.task);
}

/** 后台任务托盘：复用 subagent_list，列出运行/完成/失败任务，运行中可取消。无任务时不渲染。 */
export function TaskTray() {
  const { workspace } = useAgentStoreContext();
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<SubAgentItem[]>([]);

  const load = useCallback(() => {
    pi.subagentList(workspace)
      .then(setTasks)
      .catch(() => setTasks([]));
  }, [workspace]);

  const running = tasks.filter((x) => x.status === 'running').length;

  // 挂载先拉一次，并监听 pi 事件（工具/回合变化常意味着子代理启停）即时刷新。
  useEffect(() => {
    load();
    let unlisten: (() => void) | undefined;
    void onPiEvent((e) => {
      if (e.workspace !== workspace) return;
      const ty = e.event.type;
      if (ty === 'tool_execution_start' || ty === 'tool_execution_end' || ty === 'agent_end') {
        load();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [load, workspace]);

  // 仅在面板打开或有运行中任务时轮询，空闲不轮询，避免常驻定时器。
  useEffect(() => {
    if (!open && running === 0) return;
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [open, running, load]);

  const now = Date.now();
  // 自动后台任务到终态且超过淡出窗口后，从托盘移除（不长期常驻；结果另有 NoticePill 通知）。
  const visible = tasks.filter(
    (task) => !(isTerminal(task.status) && isAutoTask(task) && now - task.updatedAt > FADE_MS),
  );
  if (visible.length === 0) return null;

  const content = (
    <div className={t.panel}>
      {visible.map((task) => {
        const isRun = task.status === 'running';
        // running 但久无心跳：判定为停滞，区别于正常运行中。
        const stale = isRun && now - task.updatedAt > STALE_MS;
        const c = stale
          ? { fg: cssVar.colorWarning, bg: cssVar.colorWarningBg }
          : statusColor(task.status);
        const label = stale ? '停滞' : (STATUS_LABEL[task.status] ?? task.status);
        // 停滞后时间按最后一次心跳封顶，避免随 now 无限累加成离谱值。
        const liveTo = stale ? task.updatedAt : now;
        return (
          <div key={task.id} className={t.task}>
            {isRun && !stale ? (
              <Icon className={t.spin} icon={Loader2} size={15} />
            ) : (
              <Icon
                icon={stale ? AlertTriangle : task.status === 'error' ? XCircle : CheckCircle2}
                size={15}
                style={{ color: c.fg, flex: 'none' }}
              />
            )}
            <div className={t.body}>
              <div className={t.t1}>{task.task}</div>
              <div className={t.t2}>
                {task.model ? `${task.model} · ` : ''}
                {isRun ? `已运行 ${elapsed(task.createdAt, liveTo)}` : label}
              </div>
            </div>
            <span className={t.st} style={{ color: c.fg, background: c.bg }}>
              {label}
            </span>
            {isRun ? (
              <ActionIcon
                icon={X}
                size="small"
                title="取消"
                onClick={() => void pi.subagentCancel(workspace, task.id).then(load)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );

  return (
    <Popover
      arrow={false}
      content={content}
      open={open}
      placement="topLeft"
      trigger="click"
      onOpenChange={setOpen}
    >
      <span className={s.chip}>
        {running > 0 ? <span className={s.dot} /> : null}
        后台任务
        {running > 0 ? <span className={cx(s.badge, s.badgeRun)}>{running}</span> : null}
      </span>
    </Popover>
  );
}
