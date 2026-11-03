import { createStaticStyles, cssVar } from 'antd-style';
import { GrenAgentIcon } from '../../components/GrenAgentLogo';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

export const EMPTY_CHAT_BRAND_SIZE = 18;
export const EMPTY_CHAT_BRAND_GAP = 8;

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: clamp(9px, 1.8cqw, 14px);
    padding-inline: 24px;
    text-align: left;
  `,
  lockup: css`
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
    gap: ${EMPTY_CHAT_BRAND_GAP}px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;

    > span:last-child {
      overflow-wrap: anywhere;
      min-width: 0;
    }
  `,
  logo: css`
    flex: 0 0 auto;
    color: var(--gren-fg, ${cssVar.colorText});
    line-height: 1;
  `,
  title: css`
    margin: 0;
    min-width: 0;
    max-width: 100%;
    color: ${cssVar.colorText};
    font-size: clamp(20px, 3.8cqw, 30px);
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

  return (
    <div className={styles.wrap} data-testid="empty-chat-prompt">
      <div className={styles.lockup} data-testid="empty-chat-lockup" style={{ gap: EMPTY_CHAT_BRAND_GAP }}>
        <span className={styles.logo}>
          <GrenAgentIcon size={EMPTY_CHAT_BRAND_SIZE} aria-hidden="true" data-testid="empty-chat-brand" />
        </span>
        <span>{isConversation ? '新对话' : projectName}</span>
      </div>
      <h1 className={styles.title}>想在这里完成什么？</h1>
    </div>
  );
}
