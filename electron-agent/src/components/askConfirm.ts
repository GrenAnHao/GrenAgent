import { App } from 'antd';
import type { ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  content?: ReactNode;
  /** 删除、回退等不可逆操作把确定按钮标成危险色。 */
  danger?: boolean;
}

interface ModalConfirm {
  confirm: (config: {
    title?: ReactNode;
    content?: ReactNode;
    okText?: string;
    cancelText?: string;
    centered?: boolean;
    okButtonProps?: { danger?: boolean };
    onOk?: () => void;
    onCancel?: () => void;
  }) => void;
}

/** 用 antd Modal.confirm 做二次确认。确定为 true，取消或关闭为 false。 */
export function askConfirm(modal: ModalConfirm, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    modal.confirm({
      title: options.title,
      content: options.content,
      okText: '确定',
      cancelText: '取消',
      centered: true,
      okButtonProps: options.danger ? { danger: true } : undefined,
      onOk: () => finish(true),
      onCancel: () => finish(false),
    });
  });
}

export function useAskConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const { modal } = App.useApp();
  return (options) => askConfirm(modal, options);
}
