import { Button, Flexbox, Icon } from '@lobehub/ui';
import { ArrowUp, Square } from 'lucide-react';
import { actionMap, type ActionKey } from './config';
import { useChatInput } from './ChatInputContext';
import { composerCanSend, composerSendBehavior } from './sendBehavior';

interface SendAreaProps {
  actions: ActionKey[];
}

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

  return (
    <Flexbox horizontal align="center" gap={2}>
      {actions.map((key) => {
        const Render = actionMap[key];
        return <Render key={key} />;
      })}
      {/* 进行中（流式 / 失败重试 / 等待首响）始终显示停止，避免失败重试时只剩发送 */}
      {inFlight && (
        <Button
          shape="circle"
          title="停止"
          data-testid="composer-stop"
          icon={<Icon icon={Square} size={16} />}
          onClick={stop}
        />
      )}
      {/* 有内容可发（引导/跟进/发送），或未在进行中时（含禁用发送态） */}
      {(!inFlight || canSend) && (
        <Button
          type="primary"
          shape="circle"
          disabled={!canSend}
          title={sendBehavior === 'steer' ? '引导' : sendBehavior === 'followUp' ? '跟进' : '发送'}
          icon={<Icon icon={ArrowUp} size={16} />}
          onClick={send}
        />
      )}
    </Flexbox>
  );
}
