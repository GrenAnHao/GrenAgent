import { memo, type CSSProperties, type ReactNode } from 'react';
import { Icon, Image } from '@lobehub/ui';
import { EyeOff } from 'lucide-react';
import { createStaticStyles } from 'antd-style';
import { ChatItemShell } from './ChatItemShell';
import { chatStyles } from './chatStyles';
import { MessageActionBar } from './messageActions/MessageActionBar';
import type { MessageActionContext } from './messageActions/types';
import { renderMessageTags } from './messageTags';
import { parseAttachments } from './attachment';
import { AttachmentCard } from './AttachmentCard';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import type { AgentStoreApi } from '../../stores/agent';
import type { UserImage } from '../../stores/agentReducer';

interface UserMessageProps {
  text: string;
  images?: UserImage[];
  /** pi 毫秒 timestamp：启用「移出上下文 / 回退到此」，并据此判断是否已被排除（灰显）。 */
  timestamp?: number;
}

const styles = createStaticStyles(({ css, cssVar }) => ({
  col: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
    max-width: 100%;
  `,
  // 被移出上下文：整条气泡降透明度，加一行明确标记，传达「对模型不可见、但可恢复」。
  dimmed: css`
    opacity: 0.5;
  `,
  excludedTag: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

const gridStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

/** 纯展示（不含 hooks）：供「带 store 订阅」与「无 store 降级」两条路径复用。 */
function renderUserMessage(
  { text, images, timestamp }: UserMessageProps,
  excluded: boolean,
): ReactNode {
  const parts = parseAttachments(text);
  const bodyText = parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
  const attachments = parts.flatMap((p) => (p.type === 'attachment' ? [p.block] : []));
  const hasImages = Boolean(images?.length);
  const hasBubble = hasImages || bodyText.length > 0;

  const ctx: MessageActionContext = { role: 'user', text: bodyText, timestamp };
  const actions = bodyText ? (
    <MessageActionBar
      ctx={ctx}
      bar={['rewind', 'exclude', 'copy']}
      menu={['copy', 'divider', 'rewind', 'exclude', 'divider', 'edit', 'regenerate', 'del']}
    />
  ) : undefined;

  return (
    <ChatItemShell placement="right" bubble={false} actions={actions}>
      <div className={excluded ? `${styles.col} ${styles.dimmed}` : styles.col}>
        {excluded ? (
          <span className={styles.excludedTag}>
            <Icon icon={EyeOff} size="small" />
            已移出上下文
          </span>
        ) : null}
        {hasBubble ? (
          <div className={chatStyles.bubble}>
            {hasImages ? (
              // PreviewGroup：点击任一图片放大查看，多图可左右切换。
              <Image.PreviewGroup>
                <div style={{ ...gridStyle, marginBottom: bodyText ? 8 : 0 }}>
                  {images!.map((img, i) => (
                    <Image
                      key={i}
                      alt=""
                      src={`data:${img.mimeType};base64,${img.data}`}
                      maxWidth={220}
                      maxHeight={220}
                      styles={{ image: { borderRadius: 8 } }}
                    />
                  ))}
                </div>
              </Image.PreviewGroup>
            ) : null}
            {bodyText ? (
              <span style={{ whiteSpace: 'pre-wrap' }}>{renderMessageTags(bodyText)}</span>
            ) : null}
          </div>
        ) : null}
        {attachments.map((block, i) => (
          <AttachmentCard key={i} block={block} />
        ))}
      </div>
    </ChatItemShell>
  );
}

/** 有 store 上下文 + 带 timestamp：订阅排除态以灰显。 */
function ExcludableUserMessage(props: UserMessageProps & { store: AgentStoreApi; timestamp: number }) {
  const excluded = props.store.useStore((s) => s.excluded.has(props.timestamp));
  return renderUserMessage(props, excluded);
}

function UserMessageInner({ text, images, timestamp }: UserMessageProps) {
  const storeCtx = useOptionalAgentStoreContext();
  if (storeCtx && timestamp != null) {
    return (
      <ExcludableUserMessage
        text={text}
        images={images}
        timestamp={timestamp}
        store={storeCtx.store}
      />
    );
  }
  return renderUserMessage({ text, images, timestamp }, false);
}

export const UserMessage = memo(UserMessageInner);
