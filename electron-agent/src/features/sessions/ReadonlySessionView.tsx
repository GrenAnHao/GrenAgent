import { useMemo } from 'react';
import { createStaticStyles } from 'antd-style';
import { useChildSessionBinding } from '../panels/useChildSessionBinding';
import { groupMessages } from '../chat/groupMessages';
import { ChatMessageItems } from '../chat/ChatMessageItems';
import { computeAnsweredQuestions, computeSubAgentUnits } from '../chat/messagePrecompute';

const styles = createStaticStyles(({ css }) => ({
  viewer: css`
    display: flex;
    flex-direction: column;
    height: 70vh;
    min-height: 320px;
  `,
}));

/**
 * 只读看一份会话的 JSONL：不起运行时、没有输入框。
 * 独立工作区已删除的会话、已归档的会话都用它。
 */
export function ReadonlySessionView({ sessionPath, testId }: { sessionPath: string; testId: string }) {
  const messages = useChildSessionBinding(sessionPath, false);
  const display = useMemo(() => groupMessages(messages), [messages]);
  const units = useMemo(() => computeSubAgentUnits(display), [display]);
  const answered = useMemo(() => computeAnsweredQuestions(display), [display]);
  return (
    <div className={styles.viewer} data-testid={testId}>
      <ChatMessageItems
        messages={display}
        unitsByMessage={units.unitsByMessage}
        hiddenSpawnIds={units.hidden}
        spawnOverlay={units.overlay}
        answeredQuestions={answered}
        paddingInline={8}
        resetKey={sessionPath}
      />
    </div>
  );
}
