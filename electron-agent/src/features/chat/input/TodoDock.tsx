import { useState } from 'react';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronUp, CircleCheck, CircleDashed, ListChecks, Loader2 } from 'lucide-react';
import type { Todo } from '@extensions/_shared/todo-model';
import { useAgentStore } from '../../../stores/AgentStoreContext';
import { dockCard } from './dockCard';
import { latestTodosFromMessages } from './latestTodos';

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
    color: ${cssVar.colorTextSecondary};
    text-align: left;
  `,
  title: css`
    flex: none;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  counts: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
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

function statusIcon(status: Todo['status']) {
  if (status === 'completed') {
    return <Icon icon={CircleCheck} size={14} style={{ flex: 'none', color: cssVar.colorSuccess }} />;
  }
  if (status === 'in_progress') {
    return <Icon icon={Loader2} size={14} spin style={{ flex: 'none' }} />;
  }
  return <Icon icon={CircleDashed} size={14} style={{ flex: 'none', color: cssVar.colorTextQuaternary }} />;
}

export function TodoDock({ todos }: { todos: readonly Todo[] }) {
  const [collapsed, setCollapsed] = useState(true);
  if (todos.length === 0) return null;

  return (
    <div className={dockCard.card} data-cap-layer="" data-dock-card="" data-testid="todo-dock">
      <button
        aria-expanded={!collapsed}
        aria-label="任务"
        className={styles.header}
        type="button"
        onClick={() => setCollapsed((value) => !value)}
      >
        <Icon icon={ListChecks} size={14} />
        <span className={styles.title}>任务</span>
        <span className={styles.counts}>{todoProgressLabel(todos)}</span>
        <Icon className={styles.chev} icon={collapsed ? ChevronUp : ChevronDown} size={14} />
      </button>
      {!collapsed && (
        <ul className={styles.list} data-testid="todo-dock-list" style={{ maxHeight: '180px' }}>
          {todos.map((todo) => (
            <li key={todo.id} className={styles.item}>
              {statusIcon(todo.status)}
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
  const todos = latestTodosFromMessages(messages);
  if (!todos || todos.length === 0) return null;
  return <TodoDock todos={todos} />;
}
