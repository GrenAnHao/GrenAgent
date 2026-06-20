import { memo, type CSSProperties } from 'react';
import { Image } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ChatItemShell } from './ChatItemShell';
import { chatStyles } from './chatStyles';
import { MessageActionBar } from './messageActions/MessageActionBar';
import type { MessageActionContext } from './messageActions/types';
import { renderMessageTags } from './messageTags';
import { parseAttachments } from './attachment';
import { AttachmentCard } from './AttachmentCard';
import type { UserImage } from '../../stores/agentReducer';

interface UserMessageProps {
  text: string;
  images?: UserImage[];
}

const styles = createStaticStyles(({ css }) => ({
  col: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
    max-width: 100%;
  `,
}));

const gridStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

function UserMessageInner({ text, images }: UserMessageProps) {
  const parts = parseAttachments(text);
  const bodyText = parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
  const attachments = parts.flatMap((p) => (p.type === 'attachment' ? [p.block] : []));
  const hasImages = Boolean(images?.length);
  const hasBubble = hasImages || bodyText.length > 0;

  const actions = bodyText
    ? (() => {
        const ctx: MessageActionContext = { role: 'user', text: bodyText };
        return (
          <MessageActionBar
            ctx={ctx}
            bar={['regenerate', 'edit', 'copy']}
            menu={['edit', 'copy', 'divider', 'regenerate', 'del']}
          />
        );
      })()
    : undefined;

  return (
    <ChatItemShell placement="right" bubble={false} actions={actions}>
      <div className={styles.col}>
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

export const UserMessage = memo(UserMessageInner);
