import { useEffect, useState } from 'react';
import { Drawer } from 'antd';
import { X } from 'lucide-react';
import { ProjectContextTabs, type ProjectContextTab } from './ProjectContextTabs';
import { wsStyles as s } from './styles';
import type { PastedText } from '../editor/types';

interface ProjectContextDrawerProps {
  name: string;
  onClose: () => void;
  onReferencePastedText?: (item: PastedText) => void;
  open: boolean;
  workspace: string;
}

/** 项目上下文抽屉壳；各标签的数据加载与引用操作由后续标签功能负责。 */
export function ProjectContextDrawer({
  name,
  onClose,
  onReferencePastedText: _onReferencePastedText,
  open,
  workspace,
}: ProjectContextDrawerProps) {
  const [activeTab, setActiveTab] = useState<ProjectContextTab>('overview');

  useEffect(() => {
    setActiveTab('overview');
  }, [workspace]);

  const handleClose = () => {
    setActiveTab('overview');
    onClose();
  };

  return (
    <Drawer
      aria-label={`${name} 项目上下文`}
      className={s.projectContextDrawer}
      closable={false}
      destroyOnHidden
      extra={(
        <button
          aria-label="关闭项目上下文"
          className={s.projectContextDrawerClose}
          type="button"
          onClick={handleClose}
        >
          <X size={16} />
        </button>
      )}
      mask={false}
      open={open}
      placement="right"
      size="min(520px, 92vw)"
      styles={{ body: { padding: 0 } }}
      title={(
        <div className={s.projectContextDrawerTitle}>
          <span>{name} 项目上下文</span>
          <span className={s.projectContextDrawerPath}>{workspace}</span>
        </div>
      )}
      onClose={handleClose}
    >
      <ProjectContextTabs activeTab={activeTab} onTabChange={setActiveTab} />
    </Drawer>
  );
}
