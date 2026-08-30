import { createStaticStyles } from 'antd-style';
import { SearchBox } from './SearchBox';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    /* 左右 12px 与 PanelHeader 的 padding-inline 对齐；上 12px 留白，
       下 0 是因为紧邻的分区标题(.sec)自带 12px 顶距，与顶部形成对称的 12/12 留白。 */
    padding: 12px 12px 0;
  `,
}));

export function SidebarActions() {
  return (
    <div className={styles.wrap}>
      <SearchBox />
    </div>
  );
}
