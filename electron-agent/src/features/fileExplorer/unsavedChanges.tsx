import { Button } from 'antd';
import type { FC, ReactNode } from 'react';
import { getCurrentWindow } from '../../platform/runtime';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

interface ConfirmFooterParts {
  OkBtn: FC;
  CancelBtn: FC;
}

interface ConfirmHandle {
  destroy: () => void;
}

export interface UnsavedModal {
  confirm: (config: {
    title?: ReactNode;
    content?: ReactNode;
    okText?: string;
    cancelText?: string;
    centered?: boolean;
    onOk?: () => void;
    onCancel?: () => void;
    footer?: (origin: ReactNode, parts: ConfirmFooterParts) => ReactNode;
  }) => ConfirmHandle;
}

/** 「保存 / 放弃 / 取消」三选一。关掉对话框按取消算。 */
export function askUnsaved(modal: UnsavedModal, fileName: string): Promise<UnsavedChoice> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: UnsavedChoice) => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    const handle = modal.confirm({
      title: `${fileName} 有未保存的修改`,
      content: '不保存的话，这些修改会丢掉。',
      okText: '保存',
      cancelText: '取消',
      centered: true,
      onOk: () => finish('save'),
      onCancel: () => finish('cancel'),
      footer: (_origin, { OkBtn, CancelBtn }) => (
        <>
          <Button
            data-testid="file-unsaved-discard"
            danger
            onClick={() => {
              finish('discard');
              handle.destroy();
            }}
          >
            放弃修改
          </Button>
          <CancelBtn />
          <OkBtn />
        </>
      ),
    });
  });
}

interface UnsavedEntry {
  isDirty: () => boolean;
  /** 问用户怎么处理未保存的修改；可以继续（已保存或放弃）返回 true。 */
  resolve: () => Promise<boolean>;
}

const entries = new Map<string, UnsavedEntry>();
let windowClosing = false;

/**
 * 关窗口前（含 app 退出）还有未保存修改：先拦下这次关闭，逐个问完再自己关窗。
 * Electron 里 beforeunload 被拦只是静默不关，提示得我们自己弹。
 */
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (windowClosing) return;
  const dirty = [...entries.values()].filter((entry) => entry.isDirty());
  if (dirty.length === 0) return;
  event.preventDefault();
  event.returnValue = '';
  void (async () => {
    for (const entry of dirty) {
      if (!(await entry.resolve())) return;
    }
    windowClosing = true;
    await getCurrentWindow().close();
  })();
}

/** 登记一个文件浏览器的未保存状态，返回注销函数。 */
export function registerUnsaved(id: string, entry: UnsavedEntry): () => void {
  if (entries.size === 0) window.addEventListener('beforeunload', onBeforeUnload);
  entries.set(id, entry);
  return () => {
    if (entries.get(id) !== entry) return;
    entries.delete(id);
    if (entries.size === 0) window.removeEventListener('beforeunload', onBeforeUnload);
  };
}
