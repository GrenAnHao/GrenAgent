import { createStaticStyles, cssVar } from 'antd-style';
import { PiBrandLogo } from '../../components/PiBrandLogo';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

export const EMPTY_CHAT_BRAND_SIZE = 23;
export const EMPTY_CHAT_BRAND_GAP = 9;

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 0 32px 16px;
    text-align: center;
  `,
  lockup: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    gap: ${EMPTY_CHAT_BRAND_GAP}px;
  `,
  logo: css`
    flex: 0 0 auto;
    color: ${cssVar.colorText};
    line-height: 1;
  `,
  title: css`
    margin: 0;
    min-width: 0;
    /* 跟输入列同宽，只扣掉 π 和间距。固定 520px 会在宽画布上把长项目名提前折成两行。 */
    max-width: calc(100% - ${EMPTY_CHAT_BRAND_SIZE + EMPTY_CHAT_BRAND_GAP}px);
    color: ${cssVar.colorText};
    font-size: 28px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.02em;
    text-wrap: balance;
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
      <div className={styles.lockup} data-testid="empty-chat-lockup" style={{ gap: EMPTY_CHAT_BRAND_GAP }}>
        <span className={styles.logo}>
          <PiBrandLogo size={EMPTY_CHAT_BRAND_SIZE} tight data-testid="empty-chat-brand" />
        </span>
        <h1 className={styles.title}>{title}</h1>
      </div>
    </div>
  );
}
