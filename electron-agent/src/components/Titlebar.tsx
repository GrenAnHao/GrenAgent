import { useEffect, useState } from 'react';
import { ActionIcon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { getCurrentWindow } from '../platform/runtime';
import { TITLE_BAR_HEIGHT } from './titlebarConstants';
import { GrenAgentBrand } from './GrenAgentBrand';

export { TITLE_BAR_HEIGHT };

const appWindow = getCurrentWindow();

const styles = createStaticStyles(({ css }) => ({
  bar: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;

    height: ${TITLE_BAR_HEIGHT}px;
    padding-inline: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    background: var(--gren-titlebar-bg, ${cssVar.colorBgContainer});
    user-select: none;
    -webkit-app-region: drag;
  `,
  title: css`
    /* Let clicks fall through to the drag-region parent so the brand area is draggable. */
    pointer-events: none;

    font-size: 13px;
    font-weight: 700;
    color: ${cssVar.colorText};
  `,
  controls: css`
    display: flex;
    gap: 4px;
    align-items: center;
    -webkit-app-region: no-drag;
  `,
  control: css`
    border-radius: 8px;
    color: ${cssVar.colorTextSecondary};

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  close: css`
    border-radius: 8px;
    color: ${cssVar.colorTextSecondary};

    &:hover {
      color: ${cssVar.colorBgBase};
      background: ${cssVar.colorError};
    }
  `,
}));

export function Titlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then(setMaximized);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  return (
    <div data-tauri-drag-region className={styles.bar}>
      <span data-tauri-drag-region className={styles.title}>
        <GrenAgentBrand size={16} />
      </span>
      <div className={styles.controls}>
        <ActionIcon
          icon={Minus}
          size={{ blockSize: 28, size: 14 }}
          title="最小化"
          className={styles.control}
          onClick={() => void appWindow.minimize()}
        />
        <ActionIcon
          icon={maximized ? Minimize2 : Maximize2}
          size={{ blockSize: 28, size: 14 }}
          title={maximized ? '还原' : '最大化'}
          className={styles.control}
          onClick={async () => {
            await appWindow.toggleMaximize();
            setMaximized(await appWindow.isMaximized());
          }}
        />
        <ActionIcon
          icon={X}
          size={{ blockSize: 28, size: 14 }}
          title="关闭"
          className={styles.close}
          onClick={() => void appWindow.close()}
        />
      </div>
    </div>
  );
}
