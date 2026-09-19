import { Button, Flexbox, Icon } from '@lobehub/ui';
import { App, Dropdown, Popconfirm, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { openDirectory as openDialog } from '../../platform/runtime';
import {
  FileArchive,
  FileText,
  FolderInput,
  FolderOpen,
  Import,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
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
  openSkillsDir,
  type SkillInfo,
} from '../../lib/skillsIo';
import { AddSkillModal } from './AddSkillModal';
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
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  onChanged: () => void;
}

const styles = createStaticStyles(({ css }) => ({
  heroBar: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  `,
  hero: css`
    display: flex;
    align-items: center;
    gap: 10px;
  `,
  heroIcon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    border-radius: 8px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorText};
  `,
  heroTitle: css`
    display: inline-flex;
    align-items: center;
    font-size: 17px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  count: css`
    margin-inline-start: 8px;
    padding: 1px 8px;
    border-radius: 999px;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    font-weight: 500;
  `,
  desc: css`
    margin-block: 8px 16px;
    font-size: 13px;
    line-height: 1.55;
    color: ${cssVar.colorTextSecondary};
  `,
  code: css`
    padding: 1px 5px;
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
  `,
  viewToggle: css`
    display: inline-flex;
    align-items: center;
    padding: 2px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillTertiary};
  `,
  viewBtn: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &[data-active='true'] {
      background: ${cssVar.colorBgContainer};
      color: ${cssVar.colorText};
    }
  `,
  catalog: css`
    display: flex;
    flex-direction: column;
  `,
  catalogGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
  `,
  card: css`
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  cardGrid: css`
    flex-direction: column;
    align-items: stretch;
    margin-block-end: 0;
  `,
  identity: css`
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
  `,
  actions: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  `,
  actionsGrid: css`
    justify-content: flex-end;
    width: 100%;
  `,
  avatar: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex: 0 0 auto;
    border-radius: 8px;
    color: ${cssVar.colorTextLightSolid};
    font-size: 15px;
    font-weight: 600;
    text-transform: uppercase;
  `,
  meta: css`
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  `,
  name: css`
    overflow: hidden;
    color: ${cssVar.colorText};
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  summary: css`
    overflow: hidden;
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  summaryGrid: css`
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    white-space: normal;
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px 0;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  delete: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorErrorBg};
      color: ${cssVar.colorError};
    }
  `,
}));

function parseDisabled(csv: string): Set<string> {
  return new Set(csv.split(',').map((value) => value.trim()).filter(Boolean));
}

function bareName(name: string): string {
  return name.startsWith('skill:') ? name.slice(6) : name;
}

function avatarBackground(name: string): string {
  let hue = 0;
  for (const char of name) hue = (hue * 31 + char.codePointAt(0)!) % 360;
  return `hsl(${hue} 52% 48%)`;
}

export function NativeSkillsPanel({ values, setValue, onChanged }: NativeSkillsPanelProps) {
  const { message } = App.useApp();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<SkillCatalogView>(readCatalogView);
  const setCatalogView = (next: SkillCatalogView) => {
    setView(next);
    writeCatalogView(next);
  };

  const reloadSkills = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await listSkills());
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

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
    await deleteSkill(skill.path);
    if (disabled.has(skill.name)) {
      const next = new Set(disabled);
      next.delete(skill.name);
      setValue('SKILLS_DISABLED', Array.from(next).join(','));
    }
    await reloadSkills();
    bumpResources();
  };

  const runImport = async (selected: string | string[] | null, importer: (path: string) => Promise<SkillInfo>) => {
    if (typeof selected !== 'string') return;
    try {
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
        icon: <FileArchive size={14} />,
        onClick: async () => runImport(await openDialog({ multiple: false, filters: [{ name: 'Zip', extensions: ['zip'] }] }), installSkillFromZip),
      },
      {
        key: 'dir',
        label: '导入技能目录',
        icon: <FolderInput size={14} />,
        onClick: async () => runImport(await openDialog({ directory: true, multiple: false }), importSkillFromDir),
      },
      {
        key: 'file',
        label: '导入单文件 (SKILL.md)',
        icon: <FileText size={14} />,
        onClick: async () => runImport(await openDialog({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] }), importSkillFromFile),
      },
    ],
  };

  const openDirectory = async () => {
    try {
      await openSkillsDir();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <div className={styles.heroBar}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}><Sparkles size={18} /></span>
          <span className={styles.heroTitle}>
            本机 Skills
            {skills.length > 0 ? <span className={styles.count}>{skills.length}</span> : null}
          </span>
        </div>
        <Flexbox horizontal align="center" gap={8}>
          <div className={styles.viewToggle} role="group" aria-label="视图">
            <button type="button" className={styles.viewBtn} data-active={view === 'list'} data-testid="skill-view-list" title="列表" aria-pressed={view === 'list'} onClick={() => setCatalogView('list')}>
              <Icon icon={List} size={14} />
            </button>
            <button type="button" className={styles.viewBtn} data-active={view === 'grid'} data-testid="skill-view-grid" title="网格" aria-pressed={view === 'grid'} onClick={() => setCatalogView('grid')}>
              <Icon icon={LayoutGrid} size={14} />
            </button>
          </div>
          <Button size="small" loading={loading} data-testid="skill-refresh" icon={<RefreshCw size={14} />} onClick={() => void handleRefresh()}>刷新</Button>
          <Button size="small" data-testid="skill-open-dir" icon={<FolderOpen size={14} />} onClick={() => void openDirectory()}>打开目录</Button>
          <Dropdown menu={importMenu} trigger={['click']}>
            <Button size="small" data-testid="skill-import" icon={<Import size={14} />}>导入</Button>
          </Dropdown>
          <Button type="primary" size="small" data-testid="skill-add" icon={<Plus size={14} />} onClick={() => setModalOpen(true)}>新增技能</Button>
        </Flexbox>
      </div>
      <div className={styles.desc}>
        原生 Skill 保存在 <code className={styles.code}>~/.agents/skills</code> 与 <code className={styles.code}>~/.pi/agent/skills</code>；自研 Agent Data 模块不修改本机 Skill 目录。
      </div>
      {skills.length === 0 ? (
        <div className={styles.empty} data-testid="skills-empty"><Sparkles size={22} /><span>未发现本机技能，点右上「新增技能」或导入</span></div>
      ) : (
        <div className={`${styles.catalog} ${view === 'grid' ? styles.catalogGrid : ''}`} data-testid="skill-catalog" data-view={view}>
          {skills.map((skill) => {
            const off = disabled.has(skill.name);
            const summary = formatSkillSummary(skill.description);
            return (
              <div key={`${skill.scope}:${skill.name}`} className={`${styles.card} ${view === 'grid' ? styles.cardGrid : ''}`} data-testid={`skill-${skill.name}`}>
                <div className={styles.identity}>
                  <span className={styles.avatar} style={{ background: avatarBackground(skill.name) }}>{skill.name.slice(0, 1)}</span>
                  <div className={styles.meta}>
                    <span className={styles.name}>{skill.name}</span>
                    {summary ? <span className={`${styles.summary} ${view === 'grid' ? styles.summaryGrid : ''}`} data-testid={`skill-summary-${skill.name}`}>{summary}</span> : null}
                  </div>
                </div>
                <div className={`${styles.actions} ${view === 'grid' ? styles.actionsGrid : ''}`}>
                  <Switch size="small" checked={!off} onChange={() => toggleSkill(skill.name)} data-testid={`skill-toggle-${skill.name}`} />
                  <Popconfirm
                    title="永久删除技能"
                    description={`确定删除「${skill.name}」吗？将从磁盘移除整个文件夹，不可恢复。`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true, 'data-testid': `skill-delete-confirm-${skill.name}` }}
                    onConfirm={() => void handleDelete(skill)}
                  >
                    <button type="button" className={styles.delete} data-testid={`skill-delete-${skill.name}`} title="永久删除"><Trash2 size={15} /></button>
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <AddSkillModal open={modalOpen} existingNames={skills.map((skill) => skill.name)} onSubmit={handleCreate} onClose={() => setModalOpen(false)} />
    </>
  );
}
