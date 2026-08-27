import type { ProjectContextPayload } from '../../stores/dockStore';
import { ProjectContextPanel } from '../chat/input/workspace/ProjectContextPanel';
import type { DockBodyProps } from './TabBodyRenderer';

export function ProjectContextBody({ tab, active }: DockBodyProps) {
  const { workspace } = tab.payload as ProjectContextPayload;
  return <ProjectContextPanel active={active} workspace={workspace} />;
}
