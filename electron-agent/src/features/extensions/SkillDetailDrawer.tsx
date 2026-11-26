import { App, Button, Drawer, Spin } from 'antd';
import { createStaticStyles, cssVar, useThemeMode } from 'antd-style';
import { File, Folder } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useAskConfirm } from '../../components/askConfirm';
import { listSkillFiles, readSkill, saveSkill, type SkillDetail, type SkillInfo } from '../../lib/skillsIo';
import { detectLineSeparator } from '../fileExplorer/fileKinds';
import { errorText } from './errorText';

const Editor = lazy(() => import('../fileExplorer/CodeEditor'));
const styles = createStaticStyles(({ css }) => ({
  title: css`font-size:var(--gren-font-section); font-weight:600;`,
  sections: css`display:flex; flex-direction:column; gap:18px; height:100%; min-height:360px;
    h4 { color:${cssVar.colorTextSecondary}; font-size:var(--gren-font-secondary); font-weight:500; margin:0 0 5px; }
    p { margin:0; overflow-wrap:anywhere; } code { font-size:var(--gren-font-secondary); overflow-wrap:anywhere; }
    summary { cursor:pointer; } summary svg, li svg { vertical-align:middle; margin-inline-end:5px; }
    ul { margin:4px 0; padding-inline-start:16px; list-style:none; } li { font-size:var(--gren-font-secondary); line-height:1.8; } `,
  source: css`flex:1; min-height:230px; overflow:hidden; border:1px solid ${cssVar.colorBorderSecondary}; border-radius:8px;`,
  tree: css`max-height:180px; overflow:auto; flex-shrink:0;`,
}));
type LoadFolder = (folder: string) => Promise<string[]>;
function ResourceFolder({ name, path, load }: { name: string; path: string; load: LoadFolder }) {
  const [entries, setEntries] = useState<string[]>();
  const [error, setError] = useState('');
  const pending = useRef(false);
  async function expand() {
    if (pending.current || entries) return;
    pending.current = true;
    try { setError(''); setEntries(await load(path)); }
    catch (e) { setError(errorText(e)); }
    finally { pending.current = false; }
  }
  return <details onToggle={(e) => { if (e.currentTarget.open) void expand(); }}>
    <summary><Folder size={13} />{name}</summary>
    {error ? <span role="alert">{error} <Button size="small" onClick={() => void expand()}>重试</Button></span>
      : entries ? <FileTree entries={entries} parent={path + '/'} load={load} /> : <span>正在读取…</span>}
  </details>;
}
function FileTree({ entries, parent = '', load }: { entries: string[]; parent?: string; load: LoadFolder }) {
  return <ul>{entries.map((entry) => <li key={entry}>{entry.endsWith('/')
    ? <ResourceFolder name={entry.slice(0, -1)} path={parent + entry.slice(0, -1)} load={load} />
    : <><File size={13} />{entry}</>}</li>)}</ul>;
}
export function SkillDetailDrawer({ skill, workspace, startEditing, onClose, onSaved }: {
  skill: SkillInfo; workspace: string; startEditing: boolean; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const ask = useAskConfirm();
  const { isDarkMode } = useThemeMode();
  const [detail, setDetail] = useState<SkillDetail>();
  const [editing, setEditing] = useState(startEditing);
  const [error, setError] = useState('');
  const [revision, retry] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const pull = useRef<(() => string) | null>(null);
  useEffect(() => {
    let live = true;
    setError('');
    readSkill(skill.path, workspace).then((value) => { if (live) setDetail(value); }, (e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [skill.path, workspace, revision]);
  async function close() {
    if (!saving && (!editing || !dirty || await ask({ title: '放弃未保存的技能修改？', danger: true }))) onClose();
  }
  async function save() {
    if (!detail || !pull.current || saving) return;
    const content = pull.current();
    setSaving(true);
    try {
      await saveSkill(skill.path, workspace, detail.content, content);
      setDetail({ ...detail, content }); setDirty(false); setEditing(false);
      await onSaved();
    } catch (e) { message.error(errorText(e)); } finally { setSaving(false); }
  }
  return <Drawer open title={<span className={styles.title}>{skill.name}</span>} size="min(700px, 100vw)" onClose={() => void close()}
    extra={detail && (editing ? <Button type="primary" data-testid="skill-detail-save" loading={saving} disabled={!dirty} onClick={() => void save()}>保存修改</Button>
      : <Button data-testid="skill-detail-edit" onClick={() => setEditing(true)}>编辑 SKILL.md</Button>)}>
    <div className={styles.sections} data-testid="skill-detail">
      <section><h4>触发条件</h4><p>{skill.description || '未填写 description'}</p></section>
      {error ? <p role="alert">{error} <Button size="small" onClick={() => retry(revision + 1)}>重试</Button></p> : !detail ? <Spin /> : <>
        <details className={styles.tree}><summary>脚本与资源</summary>
          <code>{skill.path}</code><FileTree entries={detail.files} load={(folder) => listSkillFiles(skill.path, workspace, folder)} /></details>
        <section className={styles.source} aria-label="SKILL.md 全文">
          <Suspense fallback={<Spin />}><Editor path="SKILL.md" docVersion={revision} value={detail.content} original={detail.content} readOnly={!editing || saving}
            showDiff={false} isDark={isDarkMode} large={false} lineSeparator={detectLineSeparator(detail.content)} bindEditorText={(get) => { pull.current = get; }}
            onActivity={() => setDirty(true)} onChange={(content) => setDirty(content !== detail.content)} /></Suspense>
        </section>
      </>}
    </div>
  </Drawer>;
}
