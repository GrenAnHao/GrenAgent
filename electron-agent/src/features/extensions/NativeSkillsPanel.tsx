import { Button, Icon } from '@lobehub/ui';
import { App, Dropdown, Input, Popconfirm, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { openDirectory as pickDirectory, openFile } from '../../platform/runtime';
import {
  ChevronDown,
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
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  onChanged: () => void;
}

const styles = createStaticStyles(({ css }) => ({
  toolbar: css`
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  `,
  toolbarButton: css`
    height: 32px;
    padding-inline: 11px;
    border-radius: 7px;
    font-size: 12px;
  `,
  sectionHeading: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 35px;
    margin-block-end: 8px;
    color: ${cssVar.colorText};
    font-size: 12px;
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
    min-height: 120px;
    overflow-y: auto;
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
    display: flex;
    flex: none;
    align-items: center;
    gap: 16px;
    min-height: 88px;
    padding: 12px 20px;

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
    gap: 16px;
    padding: 18px;
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
  divider: css`
    width: 1px;
    height: 18px;
    background: ${cssVar.colorBorderSecondary};
  `,
  source: css`
    display: flex;
    gap: 6px;
    min-width: 0;
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    line-height: 16px;

    > code {
      overflow: hidden;
      min-width: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  filter: css`
    max-width: 280px;
  `,
  noMatch: css`
    padding: 32px 0;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
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
    font-size: 14px;
    font-weight: 500;
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
    font-size: 12px;
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
    font-size: 13px;
  `,
  delete: css`
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
      background: ${cssVar.colorErrorBg};
      color: ${cssVar.colorError};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
}));

/** 技能多于这个数时才给筛选框。 */
const SKILL_FILTER_THRESHOLD = 8;

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

export function NativeSkillsPanel({ values, setValue, onChanged }: NativeSkillsPanelProps) {
  const { message } = App.useApp();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
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

  const openDirectory = async () => {
    try {
      await openSkillsDir();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const needle = filter.trim().toLowerCase();
  const shownSkills = needle
    ? skills.filter((skill) => skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))
    : skills;

  return (
    <>
      <ExtensionPageHeader
        title="技能"
        count={skills.length}
        description="让 Agent 按你的工作方式完成任务。技能来自本机目录，启用后可在会话中调用。"
        actions={
          <div className={styles.toolbar}>
            <Button className={styles.toolbarButton} loading={loading} data-testid="skill-refresh" aria-label="刷新技能" icon={<RefreshCw size={15} />} onClick={() => void handleRefresh()}>刷新</Button>
            <Button className={styles.toolbarButton} data-testid="skill-open-dir" aria-label="打开技能目录" icon={<FolderOpen size={15} />} onClick={() => void openDirectory()}>打开目录</Button>
            <Dropdown menu={importMenu} trigger={['click']}>
              <Button className={styles.toolbarButton} data-testid="skill-import" icon={<Import size={15} />}>导入<ChevronDown size={13} /></Button>
            </Dropdown>
            <Button type="primary" className={styles.toolbarButton} data-testid="skill-add" icon={<Plus size={15} />} onClick={() => setModalOpen(true)}>新增技能</Button>
          </div>
        }
      />
      <div className={styles.sectionHeading}>
        {skills.length > SKILL_FILTER_THRESHOLD ? (
          <Input
            allowClear
            size="small"
            className={styles.filter}
            placeholder="筛选技能"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            data-testid="skill-filter"
          />
        ) : <span />}
        <div className={styles.viewToggle} role="group" aria-label="视图">
          <button type="button" className={styles.viewBtn} data-active={view === 'list'} data-testid="skill-view-list" title="列表" aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => setCatalogView('list')}>
            <Icon icon={List} size={15} />
          </button>
          <button type="button" className={styles.viewBtn} data-active={view === 'grid'} data-testid="skill-view-grid" title="网格" aria-label="网格视图" aria-pressed={view === 'grid'} onClick={() => setCatalogView('grid')}>
            <Icon icon={LayoutGrid} size={15} />
          </button>
        </div>
      </div>
      {skills.length === 0 ? (
        <div className={styles.empty} data-testid="skills-empty"><Sparkles size={24} /><span>未发现本机技能，点右上「新增技能」或导入</span></div>
      ) : (
        <div className={styles.catalogScroll} data-testid="skill-catalog-scroll">
        <div className={`${styles.catalog} ${view === 'grid' ? styles.catalogGrid : ''}`} data-testid="skill-catalog" data-view={view}>
          {shownSkills.length === 0 ? <div className={styles.noMatch}>没有匹配的技能</div> : null}
          {shownSkills.map((skill) => {
            const off = disabled.has(skill.name);
            const summary = formatSkillSummary(skill.description);
            return (
              <div key={`${skill.scope}:${skill.name}`} className={`${styles.card} ${view === 'grid' ? styles.cardGrid : ''}`} data-testid={`skill-${skill.name}`} data-disabled={off}>
                <div className={styles.identity}>
                  <div className={styles.meta}>
                    <span className={styles.name}>{skill.name}</span>
                    {summary ? <span className={styles.summary} data-testid={`skill-summary-${skill.name}`}>{summary}</span> : null}
                    <span className={styles.source} data-testid={`skill-source-${skill.name}`}>
                      <span>{scopeText(skill.scope)}</span>
                      <code title={skill.path}>{skill.path}</code>
                    </span>
                  </div>
                </div>
                <div className={`${styles.actions} ${view === 'grid' ? styles.actionsGrid : ''}`}>
                  <Switch size="small" checked={!off} aria-label={`启用 ${skill.name}`} onChange={() => toggleSkill(skill.name)} data-testid={`skill-toggle-${skill.name}`} />
                  <span className={styles.divider} aria-hidden="true" />
                  <Popconfirm
                    title="永久删除技能"
                    description={`确定删除「${skill.name}」吗？将从磁盘移除整个文件夹，不可恢复。`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true, autoInsertSpace: false, 'data-testid': `skill-delete-confirm-${skill.name}` }}
                    onConfirm={() => void handleDelete(skill)}
                  >
                    <button type="button" className={styles.delete} data-testid={`skill-delete-${skill.name}`} title="永久删除" aria-label={`永久删除 ${skill.name}`}><Trash2 size={15} /></button>
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
        </div>
      )}
      <AddSkillModal open={modalOpen} existingNames={skills.map((skill) => skill.name)} onSubmit={handleCreate} onClose={() => setModalOpen(false)} />
    </>
  );
}
