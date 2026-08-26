import { Icon } from '@lobehub/ui';
import { BookOpenText, ChevronRight } from 'lucide-react';
import { wsStyles as s } from './styles';

interface ProjectContextCardProps {
  name: string;
  summary: string;
  open: boolean;
  onOpen: () => void;
}

/** 项目知识入口；抽屉内容由后续功能承接。 */
export function ProjectContextCard({ name, summary, open, onOpen }: ProjectContextCardProps) {
  return (
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="打开项目上下文"
      className={s.projectContextCard}
      data-open={open}
      data-testid="project-context-card"
      type="button"
      onClick={onOpen}
    >
      <Icon className={s.projectContextIcon} icon={BookOpenText} size={16} />
      <span className={s.projectContextBody}>
        <span className={s.projectContextLabel}>项目上下文</span>
        <span className={s.projectContextName}>{name}</span>
        <span className={s.projectContextSummary}>{summary}</span>
      </span>
      <Icon className={s.projectContextChevron} icon={ChevronRight} size={14} />
    </button>
  );
}
