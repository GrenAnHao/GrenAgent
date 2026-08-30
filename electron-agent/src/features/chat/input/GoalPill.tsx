import { memo, useCallback } from 'react';
import { ActionIcon, Icon } from '@lobehub/ui';
import { Pause, PencilLine, Play, Target, Trash2 } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { pi } from '../../../lib/pi';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useGoalStore } from '../../../stores/goalStore';

const styles = createStaticStyles(({ css }) => ({
  pill: css`
    display: flex;
    gap: 8px;
    align-items: center;

    margin-bottom: 8px;
    padding: 5px 6px 5px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgElevated};
  `,
  paused: css`
    opacity: 0.65;
  `,
  icon: css`
    flex: none;
    color: ${cssVar.colorSuccess};
  `,
  label: css`
    flex: none;
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  text: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  actions: css`
    display: flex;
    flex: none;
    gap: 2px;
  `,
}));

/**
 * Codex 风格的会话目标 pill：显示当前目标，支持修改 / 暂停恢复 / 删除。
 * 操作通过 `/goal …` 命令回传后端（与手动输入命令同一路径）。
 */
export const GoalPill = memo(function GoalPill() {
  const goal = useGoalStore((s) => s.goal);
  const { workspace } = useAgentStoreContext();

  const run = useCallback(
    (command: string) => {
      void pi.runCommand(workspace, command).catch(() => {});
    },
    [workspace],
  );

  const onEdit = useCallback(() => {
    if (!goal) return;
    const next = window.prompt('修改目标', goal.condition);
    if (next && next.trim()) run(`/goal ${next.trim()}`);
  }, [goal, run]);

  const onToggle = useCallback(() => {
    if (!goal) return;
    run(goal.paused ? '/goal resume' : '/goal pause');
  }, [goal, run]);

  const onDelete = useCallback(() => {
    if (window.confirm('删除当前目标？')) run('/goal clear');
  }, [run]);

  if (!goal) return null;

  return (
    <div className={cx(styles.pill, goal.paused && styles.paused)} data-testid="goal-pill">
      <Icon className={styles.icon} icon={Target} size={14} />
      <span className={styles.label}>{goal.paused ? '已暂停的目标' : '目标'}</span>
      <span className={styles.text} title={goal.condition}>
        {goal.condition}
      </span>
      <div className={styles.actions}>
        <ActionIcon icon={PencilLine} onClick={onEdit} size="small" title="修改目标" />
        <ActionIcon
          icon={goal.paused ? Play : Pause}
          onClick={onToggle}
          size="small"
          title={goal.paused ? '恢复目标' : '暂停目标'}
        />
        <ActionIcon icon={Trash2} onClick={onDelete} size="small" title="删除目标" />
      </div>
    </div>
  );
});
