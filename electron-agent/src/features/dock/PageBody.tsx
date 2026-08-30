import { PageContentViewer } from '../panels/PageContentViewer';
import { useDockStore, type PagePayload } from '../../stores/dockStore';
import type { DockBodyProps } from './TabBodyRenderer';

export function PageBody({ tab }: DockBodyProps) {
  const closeTab = useDockStore((s) => s.closeTab);
  return <PageContentViewer page={tab.payload as PagePayload} onClose={() => closeTab(tab.id)} />;
}
