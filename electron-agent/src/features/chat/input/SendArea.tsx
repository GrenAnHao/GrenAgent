import { Button, Flexbox, Icon } from '@lobehub/ui';
import { ArrowUp, Square } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { actionMap, type ActionKey } from './config';
import { useChatInput } from './ChatInputContext';
import { composerCanSend, composerPrimaryAction, composerSendBehavior } from './sendBehavior';

interface SendAreaProps {
  actions: ActionKey[];
}

const styles = createStaticStyles(({ css }) => ({
  send: css`
    && {
      width: 32px;
      height: 32px;
      padding: 0;
      border-radius: 12px;
    }
  `,
  stop: css`
    &&,
    &&:hover,
    &&:focus,
    &&:active {
      width: 32px;
      height: 32px;
      padding: 0;
      border-color: transparent;
      border-radius: 12px;

      color: #fff;
      background: ${cssVar.colorError};
    }
  `,
}));

export function SendArea({ actions }: SendAreaProps) {
  const { empty, attachments, pastedTexts, isStreaming, isGenerating, hasRunningTool, followUp, hasComposerQueue, inFlight, send, stop } = useChatInput();
  const canSend = composerCanSend({
    empty,
    hasAttachments: attachments.length > 0 || pastedTexts.length > 0,
    hasFollowUp: followUp.length > 0,
    hasComposerQueue,
    isStreaming,
  });
  const sendBehavior = composerSendBehavior({
    isGenerating,
    isStreaming,
    hasFollowUp: followUp.length > 0,
    hasRunningTool,
    hasComposerQueue,
  });
  const primary = composerPrimaryAction({ inFlight, canSend });
  const stopping = primary === 'stop';

  return (
    <Flexbox horizontal align="center" gap={2}>
      {actions.map((key) => {
        const Render = actionMap[key];
        return <Render key={key} />;
      })}
      <Button
        className={stopping ? styles.stop : styles.send}
        type="primary"
        disabled={!stopping && !canSend}
        data-testid={stopping ? 'composer-stop' : 'composer-send'}
        title={stopping ? '停止' : sendBehavior === 'steer' ? '引导' : sendBehavior === 'followUp' ? '跟进' : '发送'}
        icon={<Icon icon={stopping ? Square : ArrowUp} size={stopping ? 14 : 16} />}
        onClick={stopping ? stop : send}
      />
    </Flexbox>
  );
}
