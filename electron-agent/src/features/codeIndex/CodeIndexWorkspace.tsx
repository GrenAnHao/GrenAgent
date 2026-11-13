import { lazy, Suspense } from 'react';
import { createStaticStyles } from 'antd-style';

const CodeRetrievalPanel = lazy(() => import('../agentData/CodeRetrievalPanel').then((m) => ({ default: m.CodeRetrievalPanel })));

const styles = createStaticStyles(({ css }) => ({
  /** 独立入口自带页面留白，与扩展等模块页的内边距一致；矮窗口时整页滚动。 */
  page: css`
    box-sizing: border-box; height: 100%; min-width: 0; overflow: auto;
    padding: 20px 24px 24px;
    @media (max-width: 800px) { padding: 12px 16px 16px; }
  `,
}));

/**
 * 代码索引的独立入口。
 *
 * 任务视图下线后不再需要任务监视器：面板自己轮询 `agentData_code_status`，
 * 同步进行中按 1.5s 刷新，回到空闲即停。
 */
export function CodeIndexWorkspace({ visible, initialProject }: { visible: boolean; initialProject?: string }) {
  return <div className={styles.page}>
    <Suspense fallback={null}>
      <CodeRetrievalPanel visible={visible} initialProject={initialProject} />
    </Suspense>
  </div>;
}