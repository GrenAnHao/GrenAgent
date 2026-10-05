import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronUp, CircleCheck, CircleDashed, CircleDot, ListChecks, Loader2 } from 'lucide-react';
import { closeFinishedTodos, type Todo } from '@extensions/_shared/todo-model';
import { useAgentStore } from '../../../stores/AgentStoreContext';
import { dockCard } from './dockCard';
import { dockTodos } from './latestTodos';

const styles = createStaticStyles(({ css }) => ({
  header: css`
    display: flex;
    gap: 6px;
    align-items: center;
    width: 100%;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 12px;
    line-height: 18px;
    color: ${cssVar.colorTextSecondary};
    text-align: left;
  `,
  title: css`
    flex: none;
    font-weight: 500;
    line-height: inherit;
    color: ${cssVar.colorText};
  `,
  summary: css`
    display: flex;
    flex: 1;
    gap: 6px;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    line-height: inherit;
  `,
  counts: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    line-height: inherit;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  /* 有任务名时计数让出剩余宽度，长计数仍可被压成省略。 */
  countsBeside: css`
    flex: 0 1 auto;
  `,
  /* basis 0：副本的 max-content 不能撑大视口，否则溢出判断会在开关之间来回翻。 */
  nameViewport: css`
    display: flex;
    align-items: center;
    overflow: hidden;
    flex: 1 1 0;
    min-width: 4.5em;
    line-height: inherit;

    @keyframes todo-dock-marquee {
      from {
        transform: translateX(0);
      }

      to {
        transform: translateX(var(--todo-marquee-shift));
      }
    }
  `,
  nameTrack: css`
    display: flex;
    align-items: center;
    width: max-content;
    line-height: inherit;
  `,
  nameCopy: css`
    flex: none;
    line-height: inherit;
    white-space: nowrap;
  `,
  /* 扫光节奏对齐 Codex loading-shimmer-pure-text；底色用次级正文，避免再兑透明后看不清。 */
  runningText: css`
    --shimmer-base: ${cssVar.colorTextSecondary};
    --shimmer-contrast: ${cssVar.colorText};
    /* 底色单独铺满行盒。若和扫光写进同一条 background 再设 background-size，
       底色层也会被拉高，下半截透明，字就会悬在计数上方。 */
    background-color: var(--shimmer-base);
    background-image: linear-gradient(
      to right,
      transparent 0%,
      var(--shimmer-contrast) 40%,
      var(--shimmer-contrast) 60%,
      transparent 100%
    );
    background-position: -100% 0;
    background-repeat: no-repeat;
    background-size: 50% 100%;
    -webkit-background-clip: text;
    display: inline-block;
    line-height: inherit;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    animation: todo-dock-shimmer 2s steps(48, end) infinite;

    @keyframes todo-dock-shimmer {
      0% {
        background-position: -100% 0;
      }

      to {
        background-position: 250% 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      background: none;
      -webkit-text-fill-color: ${cssVar.colorTextSecondary};
      color: ${cssVar.colorTextSecondary};
      animation: none;
    }
  `,
  chev: css`
    flex: none;
    margin-inline-start: auto;
    color: ${cssVar.colorTextQuaternary};
  `,
  list: css`
    margin: 6px 0 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  `,
  item: css`
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
    padding: 2px 0;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  text: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

function todoProgressLabel(todos: readonly Todo[]): string {
  const done = todos.filter((t) => t.status === 'completed').length;
  const running = todos.filter((t) => t.status === 'in_progress').length;
  const pending = todos.filter((t) => t.status === 'pending').length;
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} 已完成`);
  if (running > 0) parts.push(`${running} 进行中`);
  if (pending > 0) parts.push(`${pending} 待处理`);
  return parts.join('\u2002·\u2002');
}

const NAME_SEP = '\u2002·\u2002';
const MARQUEE_PX_PER_SEC = 24;

function runningTaskNames(todos: readonly Todo[]): string[] {
  return todos
    .filter((todo) => todo.status === 'in_progress' && todo.text.trim() !== '')
    .map((todo) => todo.text.trim());
}

function RunningTaskNames({ names }: { names: readonly string[] }) {
  const label = names.join(NAME_SEP);
  const unit = `${label}${NAME_SEP}`;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const viewportRef = useRef<HTMLSpanElement>(null);
  const unitRef = useRef<HTMLSpanElement>(null);
  const [motion, setMotion] = useState({ copies: 1, shift: 0 });

  useLayoutEffect(() => {
    if (reduced) return;
    const viewport = viewportRef.current;
    const unitEl = unitRef.current;
    if (!viewport || !unitEl) return;

    const measure = () => {
      const unitWidth = Math.round(unitEl.getBoundingClientRect().width);
      const viewWidth = viewport.clientWidth;
      const parallel = names.length > 1;
      const overflows = unitWidth > viewWidth + 1;
      let next = { copies: 1, shift: 0 };
      if (parallel || overflows) {
        const width = unitWidth > 0 ? unitWidth : Math.max(48, unit.length * 12);
        const copies = unitWidth > 0 && viewWidth > 0 ? Math.max(2, Math.ceil(viewWidth / unitWidth) + 1) : 2;
        next = { copies, shift: width };
      }
      setMotion((prev) => (prev.copies === next.copies && prev.shift === next.shift ? prev : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(unitEl);
    return () => observer.disconnect();
  }, [label, names.length, reduced, unit, motion.copies, motion.shift]);

  const scrolling = !reduced && motion.shift > 0 && motion.copies > 1;
  const copies = scrolling ? motion.copies : 1;

  return (
    <span ref={viewportRef} className={styles.nameViewport} data-testid="todo-dock-running" title={label}>
      <span
        className={styles.nameTrack}
        data-testid="todo-dock-running-track"
        style={scrolling ? {
          animation: `todo-dock-marquee ${motion.shift / MARQUEE_PX_PER_SEC}s linear infinite`,
          ['--todo-marquee-shift' as string]: `-${motion.shift}px`,
        } : undefined}
      >
        {Array.from({ length: copies }, (_, index) => (
          <span
            key={index}
            ref={index === 0 ? unitRef : undefined}
            aria-hidden={index === 0 ? undefined : true}
            className={`${styles.nameCopy} ${styles.runningText}`}
            data-testid={index === 0 ? 'todo-dock-running-name' : undefined}
          >
            {scrolling ? unit : label}
          </span>
        ))}
      </span>
    </span>
  );
}

function statusIcon(status: Todo['status'], live: boolean) {
  if (status === 'completed') {
    return <Icon icon={CircleCheck} size={14} style={{ flex: 'none', color: cssVar.colorSuccess }} />;
  }
  if (status === 'in_progress') {
    if (!live) return <Icon icon={CircleDot} size={14} style={{ flex: 'none', color: cssVar.colorPrimary }} />;
    return <Icon icon={Loader2} size={14} spin style={{ flex: 'none' }} />;
  }
  return <Icon icon={CircleDashed} size={14} style={{ flex: 'none', color: cssVar.colorTextQuaternary }} />;
}

export function TodoDock({
  todos,
  settleFinished = false,
  runActive = true,
}: {
  todos: readonly Todo[];
  settleFinished?: boolean;
  /** 回合还在跑。停了以后，进行中不再转圈，只保留状态。 */
  runActive?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const shown = settleFinished ? closeFinishedTodos(todos) ?? todos : todos;
  if (shown.length === 0) return null;
  const executing = runActive && shown.some((todo) => todo.status === 'in_progress');
  const activeNames = collapsed && executing ? runningTaskNames(shown) : [];
  const showRunning = executing && collapsed;

  return (
    <div className={dockCard.card} data-cap-layer="" data-dock-card="" data-testid="todo-dock">
      <button
        aria-busy={showRunning}
        aria-expanded={!collapsed}
        aria-label="任务"
        className={styles.header}
        type="button"
        onClick={() => setCollapsed((value) => !value)}
      >
        <Icon icon={ListChecks} size={14} />
        <span className={styles.title}>任务</span>
        <span className={styles.summary}>
          <span className={activeNames.length > 0 ? `${styles.counts} ${styles.countsBeside}` : styles.counts}>
            {todoProgressLabel(shown)}
          </span>
          {activeNames.length > 0 ? <RunningTaskNames key={activeNames.join('\0')} names={activeNames} /> : null}
        </span>
        <Icon className={styles.chev} icon={collapsed ? ChevronUp : ChevronDown} size={14} />
      </button>
      {!collapsed && (
        <ul className={styles.list} data-testid="todo-dock-list" style={{ maxHeight: '180px' }}>
          {shown.map((todo) => (
            <li
              key={todo.id}
              className={styles.item}
              data-busy={todo.status === 'in_progress' && runActive ? 'true' : undefined}
            >
              {statusIcon(todo.status, runActive)}
              <span className={styles.text}>{todo.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TodoDockFromStore() {
  const { useStore } = useAgentStore();
  const messages = useStore((s) => s.messages);
  const runActive = useStore((s) => s.runActive);
  const assistantStop = useStore((s) => s.assistantStop);
  const todoListFinished = useStore((s) => s.todoListFinished);
  const todos = dockTodos(messages, todoListFinished === true);
  if (!todos || todos.length === 0) return null;
  return (
    <TodoDock
      todos={todos}
      runActive={runActive}
      settleFinished={!runActive && assistantStop === 'stop'}
    />
  );
}
