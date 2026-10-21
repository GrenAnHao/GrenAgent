import { memo, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { App, Tooltip } from 'antd';
import { Icon, Image } from '@lobehub/ui';
import { AtSign, CircleHelp, EyeOff } from 'lucide-react';
import { createStaticStyles, cx, keyframes } from 'antd-style';
import { ChatItemShell } from './ChatItemShell';
import { chatStyles } from './chatStyles';
import { MessageActionBar } from './messageActions/MessageActionBar';
import type { MessageActionContext } from './messageActions/types';
import { renderMessageTags } from './messageTags';
import { parseAttachments } from './attachment';
import { AttachmentCard } from './AttachmentCard';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import type { AgentStoreApi } from '../../stores/agent';
import type { ChatMessage, SteerState, UserImage } from '../../stores/agentReducer';
import { formatStructuredMessageText } from './structuredMessageText';
import { StructuredMessageBody } from './StructuredMessageBody';
import { collapseCommandBlocks } from '@extensions/prompt-commands/syntax';
import { MessageEditBox } from './MessageEditBox';
import { TaskPromptFrame } from './TaskPromptFrame';
import { isBeforeLatestCompaction } from './compactionBoundary';
import type { PromptImage } from './input/ChatInputContext';
import { loadIntoComposer } from './input/composerBridge';

interface UserMessageProps {
  /** 界面消息 id：撤回等待中的引导时按它找到这条。 */
  id?: string;
  text: string;
  images?: UserImage[];
  /** pi 毫秒 timestamp：启用「移出上下文 / 回退到此」，并据此判断是否已被排除（灰显）。 */
  timestamp?: number;
  /** 会话条目 id：截断目标。缺失时回退/编辑发送/重生成/删除不可用。 */
  entryId?: string;
  /** 执行中注入当前回合的引导。steerState 标明是否已经接进这一轮。 */
  steering?: boolean;
  steerState?: SteerState;
  /** 任务提示词：限高放在这条气泡里面。 */
  promptFrame?: boolean;
}

const steerPulse = keyframes`
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
`;

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
  steer: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    line-height: 20px;
  `,
  steerPending: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: ${cssVar.colorTextTertiary};
    font-weight: 500;

    @media (prefers-reduced-motion: no-preference) {
      animation: ${steerPulse} 1.4s ease-in-out infinite;
    }
  `,
  steerApplied: css`
    color: ${cssVar.colorPrimary};
    font-weight: 600;
  `,
  steerMissed: css`
    color: ${cssVar.colorTextTertiary};
  `,
  steerHelp: css`
    display: inline-flex;
    color: ${cssVar.colorTextQuaternary};
    cursor: help;
  `,
  appliedBubble: css`
    background: ${cssVar.colorPrimaryBg};
    border-color: ${cssVar.colorPrimaryBorder};
  `,
  framedCol: css`
    align-items: stretch;
    width: 100%;
  `,
  framedBubble: css`
    width: 100%;
    padding: 0;
    overflow: hidden;
    white-space: normal;
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

const STEER_PENDING_HELP = '正在重定向正在运行的这一轮，尚未确认。';

function SteerMark({ state }: { state: SteerState }) {
  if (state === 'consumed') {
    return (
      <span className={`${styles.steer} ${styles.steerApplied}`} data-testid="steer-status">
        <Icon icon={AtSign} size={12} />
        已引导到正在运行的这一轮
      </span>
    );
  }
  if (state === 'requeued') {
    return (
      <span className={`${styles.steer} ${styles.steerMissed}`} data-testid="steer-status">
        <Icon icon={AtSign} size={12} />
        这一轮在此生效前已结束，此消息作为独立消息运行。
      </span>
    );
  }
  return (
    <span className={styles.steer} data-testid="steer-status">
      <span className={styles.steerPending}>
        <Icon icon={AtSign} size={12} />
        正在引导…
      </span>
      <Tooltip title={STEER_PENDING_HELP}>
        <span className={styles.steerHelp} aria-label={STEER_PENDING_HELP}>
          <Icon icon={CircleHelp} size={12} />
        </span>
      </Tooltip>
    </span>
  );
}

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

function hasReplyAfterUser(
  messages: ChatMessage[],
  entryId: string | undefined,
  timestamp: number | undefined,
): boolean {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.kind !== 'user') continue;
    const sameEntry = Boolean(entryId && message.entryId && message.entryId === entryId);
    const sameTime = timestamp != null && message.timestamp != null && message.timestamp === timestamp;
    if (sameEntry || sameTime) {
      index = i;
      break;
    }
  }
  if (index < 0) return false;
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.kind === 'user') return false;
    if (message.kind === 'assistant' || message.kind === 'tool') return true;
  }
  return false;
}

function isLastInContextUser(
  messages: ChatMessage[],
  excluded: Set<number>,
  entryId: string | undefined,
  timestamp: number | undefined,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.kind !== 'user') continue;
    if (m.timestamp != null && excluded.has(m.timestamp)) continue;
    if (entryId && m.entryId) return m.entryId === entryId;
    if (timestamp != null && m.timestamp != null) return m.timestamp === timestamp;
    return false;
  }
  return false;
}

/** 还在等待注入的引导：可以取消（X），也可以先取消再放回输入框重新编辑。 */
interface PendingSteerActions {
  onCancel?: () => void;
  onEdit?: () => void;
}

/** 纯展示（不含 hooks）：供「带 store 订阅」与「无 store 降级」两条路径复用。 */
function renderUserMessage(
  { text, images, timestamp, entryId, steering, steerState, promptFrame }: UserMessageProps,
  excluded: boolean,
  onEdit?: () => void,
  pendingSteer?: PendingSteerActions,
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

  // 复制、回退、重新生成用调用文本；气泡仍按原文还原成命令胶囊。
  const ctx: MessageActionContext = {
    role: 'user',
    text: collapseCommandBlocks(bodyText),
    timestamp,
    entryId,
    images,
    onEdit,
  };
  // 等待中的引导还没进会话，回退 / 重新生成 / 删除都无从谈起，只给取消、编辑、复制。
  // ctx 不带 timestamp / entryId：走基础操作栏，执行中也不会被「忙碌时隐藏」滤掉。
  const actions = pendingSteer ? (
    <MessageActionBar
      ctx={{ role: 'user', text: ctx.text, images, onCancel: pendingSteer.onCancel, onEdit: pendingSteer.onEdit }}
      bar={['cancel', 'edit', 'copy']}
    />
  ) : bodyText ? (
    <MessageActionBar
      ctx={ctx}
      bar={['rewind', 'edit', 'copy']}
      menu={['copy', 'divider', 'rewind', 'edit', 'regenerate', 'del']}
    />
  ) : undefined;

  return (
    <ChatItemShell placement="right" bubble={false} actions={actions} fullWidth={promptFrame}>
      <div className={excluded ? `${styles.col} ${styles.dimmed}` : cx(styles.col, promptFrame && styles.framedCol)}>
        {excluded ? (
          <span className={styles.excludedTag}>
            <Icon icon={EyeOff} size="small" />
            已移出上下文
          </span>
        ) : null}
        {steering ? <SteerMark state={steerState ?? 'written'} /> : null}
        {hasBubble ? (
          <div
            className={cx(
              chatStyles.bubble,
              steerState === 'consumed' && styles.appliedBubble,
              promptFrame && styles.framedBubble,
            )}
          >
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
              promptFrame ? (
                <TaskPromptFrame text={bodyText} />
              ) : (
                <StructuredMessageBody
                  formatted={formatStructuredMessageText(bodyText)}
                  fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{renderMessageTags(bodyText)}</span>}
                />
              )
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

/**
 * store 订阅必须在这个子组件里无条件调用。
 * 父组件若按 timestamp 是否存在决定要不要 useStore，回填 timestamp 后会多出一个 Hook，整棵树崩溃。
 */
function StoreBackedUserMessage({
  id,
  text,
  images,
  timestamp,
  entryId,
  steering,
  steerState,
  promptFrame,
  store,
  editing,
  setEditing,
}: UserMessageProps & {
  store: AgentStoreApi;
  editing: boolean;
  setEditing: Dispatch<SetStateAction<boolean>>;
}) {
  // 编辑和回退拿到的是调用文本，不是展开后的 <command> 块。
  const bodyText = collapseCommandBlocks(bodyTextOf(text));
  const isBusy = store.useStore((s) => s.isStreaming || Boolean(s.awaitingResponse));
  const canEditLast = store.useStore((s) => isLastInContextUser(s.messages, s.excluded, entryId, timestamp));
  const hasReply = store.useStore((s) => hasReplyAfterUser(s.messages, entryId, timestamp));
  const aboveCompaction = store.useStore((s) => isBeforeLatestCompaction(s.messages, entryId, timestamp));
  const excludedNow = store.useStore((s) => timestamp != null && s.excluded.has(timestamp));
  const { message } = App.useApp();
  const [cancelling, setCancelling] = useState(false);
  const pendingSteer = Boolean(steering) && (steerState ?? 'written') === 'written';

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
                if (!entryId) {
                  setEditing(false);
                  return;
                }
                const result = await store.editAndSend(entryId, nextText, toUserImages(nextImages));
                if (result === 'truncate-failed') return;
                setEditing(false);
              })();
            }}
          />
        </div>
      </ChatItemShell>
    );
  }

  const onEdit =
    bodyText && entryId && !isBusy && canEditLast && !excludedNow && !aboveCompaction
      ? () => {
          // 后面已经有回复：就地改完再发送。还没有回复：不打开编辑框，原文直接回到底部输入框。
          if (hasReply) {
            setEditing(true);
            return;
          }
          void store.rewindAndLoad(entryId, bodyText);
        }
      : undefined;

  // 取消：从 Pi 的引导队列里撤下这一条，气泡跟着去掉。编辑：先取消，撤成功了再把原文和图片放回输入框，由人工再发。
  const cancelPendingSteer = async (reload: boolean) => {
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      const result = await store.cancelSteer(id);
      if (result === 'missed') {
        message?.warning?.('这条引导已经在注入当前回合，撤不回来了');
        return;
      }
      if (reload) loadIntoComposer(bodyText, images);
    } catch {
      message?.error?.('取消引导失败');
    } finally {
      setCancelling(false);
    }
  };
  const steerActions: PendingSteerActions | undefined = pendingSteer
    ? {
        onCancel: id && !cancelling ? () => void cancelPendingSteer(false) : undefined,
        onEdit: id && !cancelling ? () => void cancelPendingSteer(true) : undefined,
      }
    : undefined;

  return renderUserMessage(
    { text, images, timestamp, entryId, steering, steerState, promptFrame },
    excludedNow,
    onEdit,
    steerActions,
  );
}

function UserMessageInner({ id, text, images, timestamp, entryId, steering, steerState, promptFrame }: UserMessageProps) {
  const storeCtx = useOptionalAgentStoreContext();
  const [editing, setEditing] = useState(false);
  if (!storeCtx) {
    return renderUserMessage({ text, images, timestamp, entryId, steering, steerState, promptFrame }, false);
  }
  return (
    <StoreBackedUserMessage
      id={id}
      text={text}
      images={images}
      timestamp={timestamp}
      entryId={entryId}
      steering={steering}
      steerState={steerState}
      promptFrame={promptFrame}
      store={storeCtx.store}
      editing={editing}
      setEditing={setEditing}
    />
  );
}

export const UserMessage = memo(UserMessageInner);
