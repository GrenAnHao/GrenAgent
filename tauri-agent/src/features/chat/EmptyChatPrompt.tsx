import { createStaticStyles, cssVar } from 'antd-style';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 0 32px 16px;
    text-align: center;
  `,
  title: css`
    margin: 0;
    max-width: 520px;
    color: ${cssVar.colorText};
    font-size: 28px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.02em;
  `,
}));

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export interface EmptyChatPromptProps {
  workspace: string;
  /** true = works 目录下的「对话」模式 */
  isConversation: boolean;
}

export function EmptyChatPrompt({ workspace, isConversation }: EmptyChatPromptProps) {
  const alias = useSidebarPrefsStore((s) => s.aliases[workspace]);
  const projectName = alias || basename(workspace);

  const title = isConversation
    ? '我们该做什么？'
    : `我们应该在 ${projectName} 中构建什么？`;

  return (
    <div className={styles.wrap} data-testid="empty-chat-prompt">
      <h1 className={styles.title}>{title}</h1>
    </div>
  );
}
