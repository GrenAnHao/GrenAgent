import { Button, Flexbox, Icon } from '@lobehub/ui';
import { ArrowUp, Square } from 'lucide-react';
import { actionMap, type ActionKey } from './config';
import { useChatInput } from './ChatInputContext';

interface SendAreaProps {
  actions: ActionKey[];
}

export function SendArea({ actions }: SendAreaProps) {
  const { empty, attachments, pastedTexts, isStreaming, isGenerating, send, stop } = useChatInput();
  const canSend = !empty || attachments.length > 0 || pastedTexts.length > 0;

  return (
    <Flexbox horizontal align="center" gap={2}>
      {actions.map((key) => {
        const Render = actionMap[key];
        return <Render key={key} />;
      })}
      {/* streaming 时始终显示停止按钮，防止输入框有内容时停止入口丢失 */}
      {isStreaming && (
        <Button
          shape="circle"
          title="停止"
          icon={<Icon icon={Square} size={16} />}
          onClick={stop}
        />
      )}
      {/* 有内容可发（引导/跟进/发送），或未在 streaming 时（含禁用发送态） */}
      {(!isStreaming || canSend) && (
        <Button
          type="primary"
          shape="circle"
          disabled={!canSend}
          title={isGenerating ? '引导' : isStreaming ? '跟进' : '发送'}
          icon={<Icon icon={ArrowUp} size={16} />}
          onClick={send}
        />
      )}
    </Flexbox>
  );
}
