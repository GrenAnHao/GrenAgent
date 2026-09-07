import { useEffect, useRef, useState } from 'react';
import type { ResourceNavigation } from '../../lib/agentData';
import { useAgentDataTaskMonitor } from './AgentDataTaskProvider';
import { WikiLibraryList } from './wiki/WikiLibraryList';
import { WikiLibraryWorkspace, type WikiLibraryWorkspaceHandle } from './wiki/WikiLibraryWorkspace';
import { WikiLibraryDialog } from './wiki/WikiLibraryDialog';
import { wikiStyles } from './wiki/wikiStyles';

interface WikiPanelProps {
  /** 保留一期调用兼容；知识库导航不跟随聊天项目。 */
  initialProject?: string;
  visible?: boolean;
  navigation?: Extract<ResourceNavigation, { view: 'wiki' }>;
  navigationRequest?: number;
  onOpenTask?: (id: string) => void;
}

export function WikiPanel({ visible = true, navigation, navigationRequest = 0, onOpenTask }: WikiPanelProps) {
  const monitor = useAgentDataTaskMonitor();
  const [selectedKbId, setSelectedKbId] = useState<string>();
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [createDialog, setCreateDialog] = useState(false);
  const [pageNavigation, setPageNavigation] = useState<{ kbId: string; pageId?: string; mode?: 'read' | 'create'; request: number }>();
  const workspace = useRef<WikiLibraryWorkspaceHandle>(null);
  const navigationSequence = useRef(0);
  const pageNavigationSequence = useRef(0);
  const handledNavigation = useRef<string | undefined>(undefined);
  const navigationKey = navigation ? JSON.stringify([navigation.kbId, navigation.pageId, navigation.mode, navigationRequest]) : '';
  const current = useRef({ visible, navigationKey });
  current.current = { visible, navigationKey };
  const currentSelection = useRef(selectedKbId);
  currentSelection.current = selectedKbId;

  const openLibrary = async (kbId: string) => {
    const request = ++navigationSequence.current;
    if (selectedKbId && selectedKbId !== kbId && !await workspace.current?.confirmLeave()) return;
    if (request !== navigationSequence.current || !current.current.visible) return;
    setSelectedKbId(kbId);
    setShowWorkspace(true);
  };
  useEffect(() => {
    if (!visible || !navigation || handledNavigation.current === navigationKey) return;
    handledNavigation.current = navigationKey;
    const request = ++navigationSequence.current;
    if (createDialog) return;
    let settled = false;
    void (async () => {
      const newLibrary = navigation.mode === 'create' && !navigation.kbId;
      if ((newLibrary || navigation.kbId && selectedKbId !== navigation.kbId) && !await (workspace.current?.confirmLeave() ?? true)) return;
      if (request !== navigationSequence.current || !current.current.visible || current.current.navigationKey !== navigationKey) return;
      if (newLibrary) { setCreateDialog(true); return; }
      if (!navigation.kbId) { setShowWorkspace(false); return; }
      setSelectedKbId(navigation.kbId); setShowWorkspace(true);
      setPageNavigation({ kbId: navigation.kbId, pageId: navigation.pageId, mode: navigation.mode, request: ++pageNavigationSequence.current });
    })().finally(() => { settled = true; });
    return () => {
      navigationSequence.current++;
      if (!settled && current.current.visible && handledNavigation.current === navigationKey) handledNavigation.current = undefined;
    };
  }, [navigationKey, visible]);
  const libraryDeleted = (kbId: string) => {
    if (currentSelection.current === kbId) { setSelectedKbId(undefined); setShowWorkspace(false); }
    setRefreshVersion((value) => value + 1);
  };

  return <section data-testid="wiki-panel" className={wikiStyles.root}>
    <WikiLibraryList visible={visible && !showWorkspace} onOpen={(kbId) => void openLibrary(kbId)} refreshVersion={refreshVersion + monitor.watchedTaskVersion} onBeforeDelete={(kbId) => currentSelection.current === kbId ? workspace.current?.confirmLeave() ?? Promise.resolve(true) : Promise.resolve(true)} onDeleted={libraryDeleted} />
    {selectedKbId ? <WikiLibraryWorkspace ref={workspace} key={selectedKbId} visible={visible && showWorkspace} confirmationVisible={visible} kbId={selectedKbId} navigationPageId={pageNavigation?.kbId === selectedKbId ? pageNavigation.pageId : undefined} navigationMode={pageNavigation?.kbId === selectedKbId ? pageNavigation.mode : undefined} navigationRequest={pageNavigation?.kbId === selectedKbId ? pageNavigation.request : undefined} onBack={() => { navigationSequence.current++; setShowWorkspace(false); setRefreshVersion((value) => value + 1); }} onViewTask={onOpenTask} onDeleted={libraryDeleted} /> : null}
    <WikiLibraryDialog open={createDialog} visible={visible} onClose={() => setCreateDialog(false)} onSaved={(saved) => { setCreateDialog(false); setSelectedKbId(saved.kbId); setShowWorkspace(true); setPageNavigation(undefined); setRefreshVersion((value) => value + 1); }} />
  </section>;
}
