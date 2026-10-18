import { useState, type MouseEvent } from 'react';
import { Icon } from '@lobehub/ui';
import { Dropdown } from 'antd';
import { createStaticStyles, cx } from 'antd-style';
import {
  ChevronDown,
  ChevronUp,
  CodeXml,
  ExternalLink,
  FolderOpen,
} from 'lucide-react';
import FileIcon from '../../components/FileIcon';
import { openTurnReview } from '../dock/openLauncherTab';
import { openWorkspaceFile } from '../dock/openWorkspaceFile';
import { openPath, revealItemInDir } from '../../platform/runtime';
import type { ChangeFile, PresentedFile } from './turnDeliverables';
import { resolveSessionFile } from './sessionCwd';

const styles = createStaticStyles(({ css, cssVar }) => ({
  root: css`
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    min-width: 0;
    margin-block-start: 4px;
  `,
  changes: css`
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;
    color: ${cssVar.colorText};
  `,
  header: css`
    display: flex;
    gap: 12px;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 12px 16px;
    border: none;
    background: ${cssVar.colorFillQuaternary};
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  tile: css`
    display: grid;
    flex: none;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: ${cssVar.colorPrimary};
    color: ${cssVar.colorTextLightSolid};
  `,
  titles: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  title: css`
    overflow: hidden;
    font-size: 14px;
    font-weight: 500;
    line-height: 22px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  stat: css`
    display: inline-flex;
    gap: 6px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 18px;
  `,
  added: css`
    color: ${cssVar.colorSuccess};
  `,
  deleted: css`
    color: ${cssVar.colorError};
  `,
  list: css`
    margin: 0;
    padding: 4px 0;
    list-style: none;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  changeRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 6px 16px;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 18px;
    text-align: start;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  changeName: css`
    overflow: hidden;
    flex: 0 1 auto;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  rowDiff: css`
    display: inline-flex;
    flex-shrink: 0;
    gap: 6px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: ${cssVar.colorTextTertiary};
  `,
  changesFold: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    margin: 0;
    padding: 8px 16px;
    border: none;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font: inherit;
    font-size: 12px;
    line-height: 18px;
    text-align: start;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  presentedRoot: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  `,
  presented: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    min-width: 0;

    &[data-single='true'] {
      grid-template-columns: minmax(0, 1fr);
    }

    @container (max-width: 620px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  card: css`
    position: relative;
    box-sizing: border-box;
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
    height: 60px;
    padding: 8px 10px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  cardPreview: css`
    position: absolute;
    inset: 0;
    z-index: 1;
    width: 100%;
    padding: 0;
    border: none;
    border-radius: inherit;
    background: transparent;
    cursor: pointer;
  `,
  cardIcon: css`
    position: relative;
    z-index: 2;
    box-sizing: border-box;
    display: grid;
    flex: none;
    place-items: center;
    width: 40px;
    height: 40px;
    overflow: hidden;
    pointer-events: none;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};
  `,
  cardBody: css`
    position: relative;
    z-index: 2;
    display: flex;
    flex: 1;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    pointer-events: none;
  `,
  cardDetails: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    justify-content: center;
    min-width: 0;
  `,
  cardName: css`
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  cardDesc: css`
    overflow: hidden;
    color: ${cssVar.colorTextTertiary};
    font-size: 10px;
    font-weight: 400;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;

    &[data-error='true'] {
      color: ${cssVar.colorError};
    }
  `,
  split: css`
    display: inline-flex;
    flex: none;
    align-items: stretch;
    box-sizing: border-box;
    height: 28px;
    overflow: hidden;
    pointer-events: auto;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};
  `,
  open: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 8px;
    border: none;
    background: none;
    color: ${cssVar.colorText};
    font: inherit;
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
    }

    &:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
  `,
  chevron: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 5px;
    border: none;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
    background: none;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;

    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
    }

    &:disabled {
      color: ${cssVar.colorTextQuaternary};
      cursor: not-allowed;
    }
  `,
  menuItem: css`
    display: inline-flex;
    gap: 8px;
    align-items: center;
  `,
  presentedFold: css`
    align-self: center;
    display: inline-flex;
    gap: 4px;
    align-items: center;
    min-width: 0;
    padding: 1px 11px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font: inherit;
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
}));

interface TurnTailProps {
  turnId: string;
  workspace: string;
  changes: ChangeFile[];
  presented: PresentedFile[];
}

type OpenPhase = 'opening' | 'opened' | 'openedDock' | 'error' | 'revealing' | 'revealed' | 'revealError';

function fallbackDescription(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && dot < base.length - 1) return base.slice(dot + 1).toUpperCase();
  return '文件';
}

function cardDescription(file: PresentedFile): string {
  const trimmed = file.description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim();
  return trimmed ? trimmed : fallbackDescription(file.path);
}

function revealFolderLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (ua.includes('Windows')) return '在文件资源管理器中显示';
  if (ua.includes('Mac') || ua.includes('Macintosh')) return '在 Finder 中显示';
  return '打开所在文件夹';
}

function phaseStatus(phase: OpenPhase, reveal: string): string {
  if (phase === 'opening') return '正在打开…';
  if (phase === 'opened') return '已在默认程序中打开';
  if (phase === 'openedDock') return '已在右侧文件标签中打开';
  if (phase === 'error') return '打开失败，点击重试';
  if (phase === 'revealing') return reveal === '打开所在文件夹' ? '正在打开所在文件夹…' : '正在文件管理器中显示…';
  if (phase === 'revealed') return reveal === '打开所在文件夹' ? '已请求打开所在文件夹' : '已请求在文件管理器中显示';
  return reveal === '打开所在文件夹' ? '无法打开所在文件夹，请重试' : '无法在文件管理器中显示，请重试';
}

function Counts({ added, deleted }: { added: number; deleted: number }) {
  return (
    <>
      <span className={styles.added}>+{added}</span>
      <span className={styles.deleted}>-{deleted}</span>
    </>
  );
}

function PresentedFileCard({ file, workspace }: { file: PresentedFile; workspace: string }) {
  // 相对路径按调用时会话的工作目录解析，不是项目根；项目工作区之外的文件也能解析。
  const target = resolveSessionFile(workspace, file.cwd, file.path);
  const resolved = target?.absolute ?? null;
  const [phase, setPhase] = useState<OpenPhase | undefined>(undefined);
  const pending = phase === 'opening' || phase === 'revealing';
  const reveal = revealFolderLabel();
  const disabled = !resolved || pending;
  const description = resolved
    ? (phase ? phaseStatus(phase, reveal) : cardDescription(file))
    : '没有可用的主机路径';
  const errored = phase === 'error' || phase === 'revealError';

  // open：可读文件在右侧「文件」标签里看，二进制 / 超大文件由 openWorkspaceFile 退回系统程序；
  // system：用户在下拉里显式选了默认应用，不拦截。
  async function run(kind: 'open' | 'system' | 'reveal', event?: Pick<MouseEvent, 'stopPropagation'>) {
    event?.stopPropagation();
    if (!target || pending) return;
    const revealing = kind === 'reveal';
    setPhase(revealing ? 'revealing' : 'opening');
    try {
      if (kind === 'reveal') {
        await revealItemInDir(target.absolute);
        setPhase('revealed');
      } else if (kind === 'system') {
        await openPath(target.absolute);
        setPhase('opened');
      } else {
        const where = await openWorkspaceFile(target.absolute, target.root);
        setPhase(where === 'dock' ? 'openedDock' : 'opened');
      }
    } catch {
      setPhase(revealing ? 'revealError' : 'error');
    }
  }

  return (
    <div data-testid="presented-file" className={styles.card}>
      {resolved ? (
        <button
          type="button"
          className={styles.cardPreview}
          title={resolved}
          aria-label={`打开 ${file.display}`}
          onClick={() => {
            void run('open');
          }}
        />
      ) : null}
      <span className={styles.cardIcon}>
        <FileIcon fileName={file.display} size={20} variant="raw" />
      </span>
      <div className={styles.cardBody}>
        <div className={styles.cardDetails}>
          <span className={styles.cardName}>{file.display}</span>
          <span className={styles.cardDesc} data-error={errored || !resolved ? true : undefined} role={phase ? 'status' : undefined}>
            {description}
          </span>
        </div>
        <div className={styles.split}>
          <button
            type="button"
            className={styles.open}
            disabled={disabled}
            onClick={(event) => {
              void run('open', event);
            }}
          >
            打开
          </button>
          <Dropdown
            trigger={['click']}
            disabled={disabled}
            menu={{
              items: [
                {
                  key: 'open',
                  label: (
                    <span className={styles.menuItem}>
                      <Icon icon={ExternalLink} size={16} />
                      用默认应用打开
                    </span>
                  ),
                },
                {
                  key: 'reveal',
                  label: (
                    <span className={styles.menuItem}>
                      <Icon icon={FolderOpen} size={16} />
                      {reveal}
                    </span>
                  ),
                },
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                void run(key === 'reveal' ? 'reveal' : 'system');
              },
            }}
          >
            <button
              type="button"
              className={styles.chevron}
              aria-label={`${file.display} 的更多文件操作`}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <Icon icon={ChevronDown} size={11} />
            </button>
          </Dropdown>
        </div>
      </div>
    </div>
  );
}

export function TurnTail({ turnId, workspace, changes, presented }: TurnTailProps) {
  const [changesExpanded, setChangesExpanded] = useState(false);
  const [presentedExpanded, setPresentedExpanded] = useState(false);

  if (changes.length === 0 && presented.length === 0) return null;

  const totalAdded = changes.reduce((sum, file) => sum + file.added, 0);
  const totalDeleted = changes.reduce((sum, file) => sum + file.deleted, 0);
  const presentedRows = presented.length > 4 && !presentedExpanded ? presented.slice(0, 4) : presented;

  return (
    <div className={styles.root}>
      {changes.length > 0 ? (
        <div data-testid="turn-changes" className={styles.changes}>
          <button
            type="button"
            className={styles.header}
            aria-label="在侧边栏查看本轮改动"
            onClick={() => openTurnReview({ turnId, fileIndex: 0, workspace })}
          >
            <span className={styles.tile} data-testid="turn-changes-tile">
              <Icon icon={CodeXml} size={18} />
            </span>
            <span className={styles.titles}>
              <span className={styles.title}>已编辑 {changes.length} 个文件</span>
              <span className={cx(styles.stat, styles.rowDiff)}>
                <Counts added={totalAdded} deleted={totalDeleted} />
              </span>
            </span>
          </button>
          <ul className={styles.list}>
            {changes.map((file, index) =>
              index < 3 || changesExpanded ? (
                <li key={file.path}>
                  <button
                    type="button"
                    className={styles.changeRow}
                    title={resolveSessionFile(workspace, file.cwd, file.path)?.absolute ?? file.path}
                    aria-label={`查看 ${file.display} 的改动`}
                    onClick={() => openTurnReview({ turnId, fileIndex: index, workspace })}
                  >
                    <span className={styles.changeName}>{file.display}</span>
                    <span className={styles.rowDiff}>
                      <Counts added={file.added} deleted={file.deleted} />
                    </span>
                  </button>
                </li>
              ) : null,
            )}
          </ul>
          {changes.length > 3 ? (
            <button
              type="button"
              className={styles.changesFold}
              aria-expanded={changesExpanded}
              aria-label={changesExpanded ? '收起改动文件列表' : `展开全部 ${changes.length} 个改动文件`}
              onClick={() => setChangesExpanded((open) => !open)}
            >
              <span>{changesExpanded ? '收起' : `全部 ${changes.length} 个文件`}</span>
              <Icon icon={changesExpanded ? ChevronUp : ChevronDown} size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
      {presented.length > 0 ? (
        <div className={styles.presentedRoot}>
          <div
            className={styles.presented}
            data-testid="presented-files"
            data-single={presented.length === 1 ? 'true' : undefined}
          >
            {presentedRows.map((file) => (
              <PresentedFileCard key={file.path} file={file} workspace={workspace} />
            ))}
          </div>
          {presented.length > 4 ? (
            <button
              type="button"
              className={styles.presentedFold}
              aria-expanded={presentedExpanded}
              aria-label={presentedExpanded ? '收起交付文件列表' : `展开全部 ${presented.length} 个交付文件`}
              onClick={() => setPresentedExpanded((open) => !open)}
            >
              <span>{presentedExpanded ? '收起' : `全部 ${presented.length} 个文件`}</span>
              <Icon icon={presentedExpanded ? ChevronUp : ChevronDown} size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
