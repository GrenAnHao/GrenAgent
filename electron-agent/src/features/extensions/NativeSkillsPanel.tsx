import { Icon } from '@lobehub/ui';
import { WorkbenchButton as Button } from '../../components/WorkbenchButton';
import { App, Dropdown, Input, Modal, Select, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { openDirectory as pickDirectory, openFile } from '../../platform/runtime';
import {
  ChevronDown,
  FileArchive,
  FileText,
  FolderInput,
  FolderOpen,
  Ellipsis,
  Archive,
  Import,
  LayoutGrid,
  List,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  createSkill,
  deleteSkill,
  importSkillFromDir,
  importSkillFromFile,
  installSkillFromZip,
  listSkills,
  openSkillFolder,
  archiveSkill,
  openSkillsDir,
  type SkillInfo,
} from '../../lib/skillsIo';
import { manualSkill, promptBudget } from './promptBudget';
import { SkillDetailDrawer } from './SkillDetailDrawer';
import { errorText } from './errorText';
import { AddSkillModal } from './AddSkillModal';
import { ExtensionPageHeader } from './ExtensionPageHeader';
import { formatSkillSummary } from './formatSkillSummary';

type SkillCatalogView = 'list' | 'grid';
const VIEW_KEY = 'pi-skills-catalog-view';

function readCatalogView(): SkillCatalogView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

function writeCatalogView(view: SkillCatalogView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // privacy / quota
  }
}

interface NativeSkillsPanelProps {
  workspace?: string;
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  onChanged: () => void;
}

const styles = createStaticStyles(({ css }) => ({
  sectionHeading: css`
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 35px;
    margin-block-end: 8px;
    color: ${cssVar.colorText};
    font-size: var(--gren-font-secondary);
    font-weight: 500;
  `,
  viewToggle: css`
    display: inline-flex;
    align-items: center;
    padding: 2px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 7px;
  `,
  viewBtn: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &[data-active='true'] {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
  /* 滚动放在外层：网格自己当滚动容器又被压成定高时，Chrome 会把行高算矮，卡片内容压到下一张上。 */
  catalogScroll: css`
    flex: 1 1 0px;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  `,
  catalog: css`
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};
  `,
  catalogGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;

    @container extension-content (max-width: 600px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  card: css`
    position: relative;
    cursor: pointer;
    &:hover { background: ${cssVar.colorFillQuaternary}; }
    display: flex;
    flex: none;
    align-items: center;
    gap: 12px;
    min-height: 78px;
    padding: 10px 16px;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }

    &[data-disabled='true'] > :first-child {
      opacity: 0.6;
    }

    @container extension-content (max-width: 480px) {
      flex-wrap: wrap;
      gap: 12px;
      padding: 16px;
    }
  `,
  cardGrid: css`
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    min-height: 150px;
    & .skill-summary { height:36px; }
    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};
  `,
  identity: css`
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 1;
    min-width: 0;

    @container extension-content (max-width: 480px) {
      flex-basis: 100%;
    }
  `,
  actions: css`
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 0 0 auto;

    @container extension-content (max-width: 480px) {
      margin-inline-start: auto;
    }
  `,
  actionsGrid: css`
    justify-content: flex-end;
    width: 100%;
  `,
  badge: css`font-size:var(--gren-font-caption); font-weight:500; letter-spacing:0.01em; line-height:15px; padding:2px 6px; flex:none; border:1px solid ${cssVar.colorBorderSecondary}; border-radius:5px; color:${cssVar.colorTextSecondary};`,
  source: css`
    display: flex;
    gap: 6px;
    min-width: 0;
    color: ${cssVar.colorTextTertiary};
    font-size: var(--gren-font-caption);
    line-height: 16px;

    > code {
      overflow: hidden;
      min-width: 0;
      font-family: var(--font-mono);
      font-variant-ligatures: none;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  filter: css`
    max-width: 360px; min-width: 130px; flex: 1 1 130px; margin-inline-end:auto;
  `,
  noMatch: css`
    padding: 32px 0;
    color: ${cssVar.colorTextTertiary};
    font-size: var(--gren-font-body);
    text-align: center;
  `,
  meta: css`
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
  `,
  name: css`
    overflow: hidden;
    color: ${cssVar.colorText};
    font-size: var(--gren-font-body);
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  summary: css`
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-secondary);
    line-height: 18px;
    overflow-wrap: anywhere;
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 48px 0;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    color: ${cssVar.colorTextTertiary};
    font-size: var(--gren-font-body);
  `,
  more: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillSecondary};
      color: ${cssVar.colorText};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
}));

function scopeText(scope: string): string {
  if (scope === 'global') return '全局';
  if (scope === 'project') return '项目';
  return scope;
}

function parseDisabled(csv: string): Set<string> {
  return new Set(csv.split(',').map((value) => value.trim()).filter(Boolean));
}

function bareName(name: string): string {
  return name.startsWith('skill:') ? name.slice(6) : name;
}

export function NativeSkillsPanel({ workspace = '', values, setValue, onChanged }: NativeSkillsPanelProps) {
  const { message } = App.useApp();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('all');
  const [scope, setScope] = useState('all');
  const [selected, select] = useState<{ skill: SkillInfo; edit: boolean }>();
  const [deleting, setDeleting] = useState<SkillInfo>();
  const [removing, setRemoving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<SkillCatalogView>(readCatalogView);
  const [filter, setFilter] = useState('');
  const setCatalogView = (next: SkillCatalogView) => {
    setView(next);
    writeCatalogView(next);
  };

  const reloadSkills = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await listSkills(workspace));
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [message, workspace]);

  useEffect(() => {
    void reloadSkills();
  }, [reloadSkills]);

  const bumpResources = () => {
    setValue('PI_RELOAD_REV', String(Date.now()));
    onChanged();
  };

  const handleRefresh = async () => {
    await reloadSkills();
    bumpResources();
  };

  const disabled = new Set(Array.from(parseDisabled(values.SKILLS_DISABLED ?? '')).map(bareName));
  const toggleSkill = (name: string) => {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setValue('SKILLS_DISABLED', Array.from(next).join(','));
    bumpResources();
  };

  const handleCreate = async (name: string, description: string, body: string) => {
    await createSkill(name, description, body);
    await reloadSkills();
    bumpResources();
  };

  const handleDelete = async (skill: SkillInfo) => {
    await deleteSkill(skill.path, workspace);
    const remaining = await listSkills(workspace);
    setSkills(remaining);
    if (skill.scope === 'global' && disabled.has(skill.name) && !remaining.some((s) => s.name === skill.name)) {
      const next = new Set(disabled);
      next.delete(skill.name);
      setValue('SKILLS_DISABLED', Array.from(next).join(','));
    }
    bumpResources();
  };

  const runImport = async (selection: Promise<string | null>, importer: (path: string) => Promise<SkillInfo>) => {
    try {
      const selected = await selection;
      if (selected === null) return;
      const skill = await importer(selected);
      await reloadSkills();
      bumpResources();
      message.success(`已导入技能「${skill.name}」`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const importMenu = {
    items: [
      {
        key: 'zip',
        label: '从 Zip 安装',
        icon: <FileArchive size={15} />,
        onClick: () => runImport(openFile({ filters: [{ name: 'Zip', extensions: ['zip'] }] }), installSkillFromZip),
      },
      {
        key: 'dir',
        label: '导入技能目录',
        icon: <FolderInput size={15} />,
        onClick: () => runImport(pickDirectory(), importSkillFromDir),
      },
      {
        key: 'file',
        label: '导入单文件 (SKILL.md)',
        icon: <FileText size={15} />,
        onClick: () => runImport(openFile({ filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] }), importSkillFromFile),
      },
    ],
  };

  const needle = filter.trim().toLowerCase();
  const shownSkills = skills.filter((s) => (scope === 'all' || scope === s.scope)
    && (status === 'all' || (status === 'off') === disabled.has(s.name))
    && (s.name + ' ' + s.description).toLowerCase().includes(needle));
  const globalNames = new Set(skills.filter((s) => s.scope === 'global').map((s) => s.name));
  const projectNames = new Set(skills.filter((s) => s.scope === 'project').map((s) => s.name));
  const tokens = promptBudget(skills.filter((s) => s.scope === 'project' || !projectNames.has(s.name)).filter((s) => !disabled.has(s.name) && !s.disableModelInvocation).map((s) => s.description).join('')).tokens;
  async function archive(skill: SkillInfo) {
    try {
      const path = await archiveSkill(skill.path, workspace);
      setValue('SKILLS_DISABLED', Array.from(new Set([...disabled, skill.name])).join(','));
      await reloadSkills(); bumpResources(); message.success('已禁用并归档。可从此目录重新导入后启用：' + path);
    } catch (e) { message.error(errorText(e)); }
  }

  return (
    <>
      <ExtensionPageHeader
        id="skill" title="技能" onRefresh={handleRefresh} onDirectory={openSkillsDir}
        metric={`已启用描述 ≈ ${tokens.toLocaleString()} Token`}
        count={skills.length}
        description="查看技能的触发条件、源文件和随附资源。"
        actions={
          <>
            <Dropdown menu={importMenu} trigger={['click']}>
              <Button data-testid="skill-import" icon={<Import size={15} />}>导入<ChevronDown size={13} /></Button>
            </Dropdown>
            <Button type="primary" data-testid="skill-add" icon={<Plus size={15} />} onClick={() => setModalOpen(true)}>新增技能</Button>
          </>
        }
      />
      <div className={styles.sectionHeading}>

          <Input
            allowClear
            size="small"
            className={styles.filter}
            placeholder="筛选技能"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            data-testid="skill-filter"
          />
        <Select size="small" aria-label="启用状态" data-testid="skill-status" value={status} onChange={setStatus} options={[{value:'all',label:'全部状态'},{value:'on',label:'已启用'},{value:'off',label:'未启用'}]} />
        <Select size="small" aria-label="作用域" data-testid="skill-scope" value={scope} onChange={setScope} options={[{value:'all',label:'全部范围'},{value:'global',label:'全局'},{value:'project',label:'项目'}]} />
        <div className={styles.viewToggle} role="group" aria-label="视图">
          <button type="button" className={styles.viewBtn} data-active={view === 'list'} data-testid="skill-view-list" title="列表" aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => setCatalogView('list')}>
            <Icon icon={List} size={15} />
          </button>
          <button type="button" className={styles.viewBtn} data-active={view === 'grid'} data-testid="skill-view-grid" title="网格" aria-label="网格视图" aria-pressed={view === 'grid'} onClick={() => setCatalogView('grid')}>
            <Icon icon={LayoutGrid} size={15} />
          </button>
        </div>
      </div>
      {loading && !skills.length ? <div className={styles.noMatch}>正在读取技能…</div> : skills.length === 0 ? (
        <div className={styles.empty} data-testid="skills-empty"><Sparkles size={24} /><span>未发现本机技能，点右上「新增技能」或导入</span></div>
      ) : (
        <div className={styles.catalogScroll} data-testid="skill-catalog-scroll">
        <div className={`${styles.catalog} ${view === 'grid' ? styles.catalogGrid : ''}`} data-testid="skill-catalog" data-view={view}>
          {shownSkills.length === 0 ? <div className={styles.noMatch}>没有匹配的技能</div> : null}
          {shownSkills.map((skill) => {
            const off = disabled.has(skill.name);
            const summary = formatSkillSummary(skill.description);
            return (
              <div key={`${skill.scope}:${skill.name}`} className={`${styles.card} ${view === 'grid' ? styles.cardGrid : ''}`} data-testid={`skill-${skill.name}`} data-disabled={off} onClick={() => select({skill, edit:false})}>
                <div className={styles.identity}>
                  <div className={styles.meta}>
                    <div style={{display:'flex', alignItems:'center', gap:8, minWidth:0}}>
                      <button type="button" title={skill.name} className={styles.name} style={{border:0,background:'none',padding:0,textAlign:'left',cursor:'pointer'}}>{skill.name}</button>
                      <span className={styles.badge}>{manualSkill(skill) ? '仅手动 / 调用' : '自动按需触发'}</span>
                    </div>
                    {summary ? <span className={styles.summary + ' skill-summary'} data-testid={`skill-summary-${skill.name}`}>{summary}</span> : null}
                    <span className={styles.source} data-testid={`skill-source-${skill.name}`}>
                      <span>{scopeText(skill.scope)}{skill.scope === 'global' && projectNames.has(skill.name) ? ' · 同名项目技能优先' : ''}</span>
                      <code title={skill.path}>{skill.path}</code>
                    </span>
                  </div>
                </div>
                <div onClick={(e) => e.stopPropagation()} className={`${styles.actions} ${view === 'grid' ? styles.actionsGrid : ''}`}>
                  <Switch size="small" checked={!off} title={projectNames.has(skill.name) && globalNames.has(skill.name) ? '全局与项目的同名技能共用此开关' : undefined} aria-label={`启用 ${skill.name}`} onChange={() => toggleSkill(skill.name)} data-testid={`skill-toggle-${skill.name}`} />
                  <Dropdown trigger={['click']} menu={{ items: [
                    { key: 'view', icon: <FileText size={14} />, label: '查看 / 编辑 SKILL.md', onClick: () => select({skill, edit:true}) },
                    { key: 'open', icon: <FolderOpen size={14} />, label: '打开所在文件夹', onClick: () => void openSkillFolder(skill.path, workspace).catch((e) => message.error(errorText(e))) },
                    { key: 'archive', icon: <Archive size={14} />, label: '禁用并归档', onClick: () => void archive(skill) },
                    { type: 'divider' },
                    { key: 'delete', danger:true, icon:<Trash2 size={14} />, label:<span data-testid={'skill-delete-' + skill.name}>彻底删除</span>, onClick: () => setDeleting(skill) },
                  ] }}>
                    <button type="button" className={styles.more} data-testid={'skill-more-' + skill.name} aria-label={skill.name + ' 更多操作'}><Ellipsis size={17} /></button>
                  </Dropdown>
                </div>
              </div>
            );
          })}
        </div>
        </div>
      )}
      {selected && <SkillDetailDrawer key={selected.skill.path} skill={skills.find((s) => s.path === selected.skill.path) ?? selected.skill}
        workspace={workspace} startEditing={selected.edit} onClose={() => select(undefined)} onSaved={handleRefresh} />}
      <Modal open={!!deleting} centered title={'彻底删除「' + (deleting?.name ?? '') + '」？'} okText="彻底删除" cancelText="取消"
        okButtonProps={{ danger:true, 'data-testid':'skill-delete-confirm-' + deleting?.name }} confirmLoading={removing}
        onCancel={() => { if (!removing) setDeleting(undefined); }} onOk={async () => {
          if (!deleting || removing) return;
          setRemoving(true);
          try { await handleDelete(deleting); setDeleting(undefined); } catch (e) { message.error(errorText(e)); } finally { setRemoving(false); }
        }}>
        将从磁盘移除整个文件夹及其中的脚本和资源，此操作不可恢复。
        <p style={{overflowWrap:'anywhere'}}><code>{deleting?.path}</code></p>
      </Modal>
      <AddSkillModal open={modalOpen} existingNames={skills.map((skill) => skill.name)} onSubmit={handleCreate} onClose={() => setModalOpen(false)} />
    </>
  );
}
