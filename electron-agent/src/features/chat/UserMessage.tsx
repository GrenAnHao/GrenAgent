import { memo, useState, type CSSProperties, type ReactNode } from 'react';
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
import { formatStructuredMessageText } from './structuredMessageText';
import { StructuredMessageBody } from './StructuredMessageBody';
import { MessageEditBox } from './MessageEditBox';
import type { PromptImage } from './input/ChatInputContext';

interface UserMessageProps {
  text: string;
  images?: UserImage[];
  /** pi 毫秒 timestamp：启用「移出上下文 / 回退到此」，并据此判断是否已被排除（灰显）。 */
  timestamp?: number;
  /** 会话条目 id：截断目标。缺失时回退/编辑发送/重生成/删除不可用。 */
  entryId?: string;
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
  editWrap: css`
    width: 100%;
  `,
}));

const gridStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

function bodyTextOf(text: string): string {
  return parseAttachments(text)
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
}

function toUserImages(images?: PromptImage[]): UserImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map((img) => ({ mimeType: img.mimeType, data: img.data }));
}

/** 纯展示（不含 hooks）：供「带 store 订阅」与「无 store 降级」两条路径复用。 */
function renderUserMessage(
  { text, images, timestamp, entryId }: UserMessageProps,
  excluded: boolean,
  onEdit?: () => void,
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

  const ctx: MessageActionContext = { role: 'user', text: bodyText, timestamp, entryId, images, onEdit };
  const actions = bodyText ? (
    <MessageActionBar
      ctx={ctx}
      bar={['rewind', 'edit', 'copy']}
      menu={['copy', 'divider', 'rewind', 'edit', 'regenerate', 'del']}
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
              <StructuredMessageBody
                formatted={formatStructuredMessageText(bodyText)}
                fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{renderMessageTags(bodyText)}</span>}
              />
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
function ExcludableUserMessage(
  props: UserMessageProps & { store: AgentStoreApi; timestamp: number; onEdit?: () => void },
) {
  const excluded = props.store.useStore((s) => s.excluded.has(props.timestamp));
  return renderUserMessage(props, excluded, props.onEdit);
}

function UserMessageInner({ text, images, timestamp, entryId }: UserMessageProps) {
  const storeCtx = useOptionalAgentStoreContext();
  const [editing, setEditing] = useState(false);
  const bodyText = bodyTextOf(text);

  if (editing) {
    return (
      <ChatItemShell placement="left" bubble={false}>
        <div className={styles.editWrap}>
          <MessageEditBox
            initialText={bodyText}
            initialImages={images}
            onCancel={() => setEditing(false)}
            onSend={(nextText, nextImages) => {
              void (async () => {
                if (!storeCtx || !entryId) {
                  setEditing(false);
                  return;
                }
                const result = await storeCtx.store.editAndSend(entryId, nextText, toUserImages(nextImages));
                if (result === 'truncate-failed') return;
                setEditing(false);
              })();
            }}
          />
        </div>
      </ChatItemShell>
    );
  }

  const onEdit = bodyText && entryId ? () => setEditing(true) : undefined;

  if (storeCtx && timestamp != null) {
    return (
      <ExcludableUserMessage
        text={text}
        images={images}
        timestamp={timestamp}
        entryId={entryId}
        store={storeCtx.store}
        onEdit={onEdit}
      />
    );
  }
  return renderUserMessage({ text, images, timestamp, entryId }, false, onEdit);
}

export const UserMessage = memo(UserMessageInner);
