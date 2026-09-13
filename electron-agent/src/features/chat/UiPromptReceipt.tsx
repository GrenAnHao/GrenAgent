import { MessageCircleQuestion } from 'lucide-react';
import { memo } from 'react';
import { MutedLine } from './conv/MutedLine';
import { parseUiPromptReceipt } from './input/overlayPrompt';

interface UiPromptReceiptProps {
  content: string;
}

const OUTCOME_HEADING = {
  answered: '已回答',
  confirmed: '已确认',
  cancelled: '已取消',
} as const;

function UiPromptReceiptInner({ content }: UiPromptReceiptProps) {
  const receipt = parseUiPromptReceipt(content);
  if (!receipt) return null;

  const heading = OUTCOME_HEADING[receipt.outcome];
  const value = receipt.value;

  return (
    <div style={{ paddingInlineStart: 4, maxWidth: '100%' }}>
      <MutedLine
        data-testid="ui-prompt-receipt"
        icon={MessageCircleQuestion}
        text={
          <>
            {heading}
            {value ? (
              <span>
                {' · '}
                <span>{value}</span>
              </span>
            ) : null}
          </>
        }
      />
    </div>
  );
}

export const UiPromptReceipt = memo(UiPromptReceiptInner);
