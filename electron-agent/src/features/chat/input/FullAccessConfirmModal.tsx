import { Icon } from '@lobehub/ui';
import { App, Checkbox, Modal } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSessionStore } from '../../../store/session';
import {
  confirmFullAccess,
  dismissFullAccessConfirm,
  useFullAccessConfirmStore,
} from '../../../stores/fullAccessConfirmStore';

const WARNING =
  '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-block: 4px 2px;
  `,
  warn: css`
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-left: 3px solid ${cssVar.colorError};
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorTextSecondary};
    font-size: 13px;
    line-height: 1.65;
  `,
  warnIcon: css`
    flex: 0 0 auto;
    margin-block-start: 2px;
    color: ${cssVar.colorError};
  `,
  warnText: css`
    margin: 0;
  `,
}));

export function FullAccessConfirmModal() {
  const { message } = App.useApp();
  const open = useFullAccessConfirmStore((s) => s.open);
  const busy = useFullAccessConfirmStore((s) => s.busy);
  const workspace = useFullAccessConfirmStore((s) => s.workspace);
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) {
      setAcknowledged(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && !busy && workspace && activeWorkspace && workspace !== activeWorkspace) {
      dismissFullAccessConfirm();
    }
  }, [open, busy, workspace, activeWorkspace]);

  const handleOk = async () => {
    if (!acknowledged) return;
    try {
      await confirmFullAccess();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Modal
      open={open}
      centered
      width={440}
      data-testid="full-access-confirm-modal"
      title="确认启用完全权限?"
      onOk={() => void handleOk()}
      onCancel={dismissFullAccessConfirm}
      okText="启用完全权限"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ danger: true, disabled: !acknowledged || busy }}
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      destroyOnHidden
    >
      <div className={styles.body}>
        <div className={styles.warn} data-testid="full-access-alert">
          <span className={styles.warnIcon}>
            <Icon icon={TriangleAlert} size={16} />
          </span>
          <p className={styles.warnText}>{WARNING}</p>
        </div>
        <Checkbox
          checked={acknowledged}
          disabled={busy}
          onChange={(e) => setAcknowledged(e.target.checked)}
        >
          我已了解风险，并愿意继续
        </Checkbox>
      </div>
    </Modal>
  );
}
