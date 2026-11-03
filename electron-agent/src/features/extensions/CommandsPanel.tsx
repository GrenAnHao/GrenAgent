import { Button } from '@lobehub/ui';
import { App, Input, Popconfirm, Tooltip } from 'antd';
import { ArrowLeft, Plus, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parsePromptParams } from '@extensions/prompt-commands/syntax';
import { deletePromptCommand, listPromptCommands, savePromptCommand, type PromptCommandInfo } from '../../lib/promptLibraryIo';
import { getFrontendCommands } from '../chat/input/commandUtils';
import { loadCommands } from '../chat/input/editor/commandLoader';
import { invalidatePromptCommands } from '../chat/input/editor/promptCommandCache';
import { CommandPillView } from '../chat/input/editor/CommandPill/CommandPillView';
import { EMPTY_COMMAND_DRAFT, validateCommandDraft, type CommandDraft } from './commandDraft';
import { errorText } from './errorText';
import { libraryStyles as styles } from './libraryStyles';
import { PromptBodyEditor } from './PromptBodyEditor';
import { ExtensionPageHeader } from './ExtensionPageHeader';
import { useAskConfirm } from '../../components/askConfirm';

interface CommandsPanelProps {
  workspace: string;
  /** 模板文件变了：让会话重载资源，新命令才会出现在 Pi 的命令表里。 */
  onResourcesChanged: () => void;
}

function draftOf(command: PromptCommandInfo): CommandDraft {
  return { originalName: command.name, name: command.name, description: command.description, body: command.body };
}

/** 新建：填了任何内容就算改过；已有：和磁盘上的版本比。 */
function isCommandDirty(draft: CommandDraft | null, saved: PromptCommandInfo | undefined): boolean {
  if (!draft) return false;
  if (!saved) return Boolean(draft.name || draft.description || draft.body);
  return draft.name !== saved.name || draft.description !== saved.description || draft.body !== saved.body;
}

export function CommandsPanel({ workspace, onResourcesChanged }: CommandsPanelProps) {
  const { message } = App.useApp();
  const ask = useAskConfirm();
  const [commands, setCommands] = useState<PromptCommandInfo[]>([]);
  const [reserved, setReserved] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      setCommands(await listPromptCommands());
    } catch (error) {
      message.error(errorText(error));
    }
  }, [message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!workspace) {
      setReserved(new Set(getFrontendCommands().map((command) => command.name)));
      return;
    }
    let cancelled = false;
    void loadCommands(workspace).then((list) => {
      if (cancelled) return;
      setReserved(new Set(list.filter((command) => command.apiSource !== 'prompt').map((command) => command.name)));
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const existing = useMemo(() => new Set(commands.map((command) => command.name)), [commands]);
  const error = draft ? validateCommandDraft(draft, reserved, existing) : null;
  const params = draft ? parsePromptParams(draft.body) : [];
  const saved = draft?.originalName ? commands.find((command) => command.name === draft.originalName) : undefined;
  const dirty = isCommandDirty(draft, saved);

  /** 有未保存的修改时先问一句，确定才换掉草稿；没改过就直接换，不等确认框。 */
  const openDraft = (next: CommandDraft) => {
    const apply = () => {
      setDraft(next);
      setMobileDetail(true);
    };
    if (!dirty) {
      apply();
      return;
    }
    void ask({ title: '放弃未保存的修改？', content: '当前命令的修改还没保存，换走后会丢失。', danger: true }).then((ok) => { if (ok) apply(); });
  };

  const afterChange = async () => {
    invalidatePromptCommands();
    await reload();
    onResourcesChanged();
  };

  const save = async () => {
    if (!draft || error) return;
    setSaving(true);
    try {
      const saved = await savePromptCommand({ ...draft, reserved: [...reserved] });
      setDraft(draftOf(saved));
      await afterChange();
      message.success(`已保存 /${saved.name}`);
    } catch (cause) {
      message.error(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.originalName) return;
    const name = draft.originalName;
    try {
      await deletePromptCommand(name);
      setDraft(null);
      setMobileDetail(false);
      await afterChange();
      message.success(`已删除 /${name}`);
    } catch (cause) {
      message.error(errorText(cause));
    }
  };

  return (
    <>
      <ExtensionPageHeader
        title="命令"
        count={commands.length}
        description="把常用提示词保存成快捷命令，在会话中输入 / 选用。文件在 ~/.pi/agent/prompts。"
        actions={<Button type="primary" icon={<Plus size={15} />} data-testid="command-new" onClick={() => openDraft({ ...EMPTY_COMMAND_DRAFT })}>新建命令</Button>}
      />
      <div className={styles.split} data-testid="command-workbench" data-mobile-detail={mobileDetail}>
        <div className={styles.list} data-testid="command-list" data-library-list>
          {commands.length === 0 ? <div className={styles.empty}>还没有命令</div> : null}
          {commands.map((command) => (
            <button
              key={command.name}
              type="button"
              className={styles.item}
              data-testid={`command-item-${command.name}`}
              data-active={draft?.originalName === command.name}
              aria-pressed={draft?.originalName === command.name}
              onClick={() => {
                if (draft?.originalName === command.name) setMobileDetail(true);
                else openDraft(draftOf(command));
              }}
            >
              <span className={styles.itemTop}>
                <CommandPillView name={command.name} args={[]} />
                {command.error ? (
                  <Tooltip title={command.error}>
                    <TriangleAlert size={15} className={styles.warn} data-testid={`command-warning-${command.name}`} />
                  </Tooltip>
                ) : null}
                {command.params.length > 0 ? <span className={styles.paramCount}>{command.params.length} 参数</span> : null}
              </span>
              {command.description ? <span className={styles.itemSummary}>{command.description}</span> : null}
            </button>
          ))}
        </div>
        <div className={styles.edit} data-testid="command-editor" data-library-editor>
          <button type="button" className={styles.back} data-testid="command-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={14} />返回列表</button>
          {draft ? (
            <>
              <div className={styles.editorHeading}>
                <h3>{draft.name ? `/${draft.name}` : '新建命令'}</h3>
                {dirty ? <span className={styles.dirty} data-testid="command-dirty">未保存</span> : null}
              </div>
              <div className={styles.sectionHeading}>基本信息</div>
              <div className={styles.formRow}>
                <div>
                  <div className={styles.label}>命令名（即文件名）</div>
                  <Input prefix="/" aria-label="命令名" data-testid="command-name-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                </div>
                <div>
                  <div className={styles.label}>描述（菜单里显示）</div>
                  <Input aria-label="命令描述" data-testid="command-description-input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
                </div>
              </div>
              <div className={styles.fillField}>
                <div className={styles.sectionHeading}>提示词模板<span>{'{名称} 插入参数，{名称=默认值} 带默认值'}</span></div>
                <PromptBodyEditor value={draft.body} onChange={(body) => setDraft({ ...draft, body })} />
              </div>
              <div className={styles.params} data-testid="command-detected-params">
                <span>识别到的参数</span>
                {params.length === 0 ? '无' : params.map((param, index) => (
                  <span key={param.name} className={styles.param}>
                    {index + 1}. {param.name}
                    {param.defaultValue !== undefined ? `（默认 ${param.defaultValue}）` : ''}
                  </span>
                ))}
              </div>
              {error ? <div className={styles.error} data-testid="command-error">{error}</div> : null}
              <div className={styles.footer}>
                {draft.originalName ? (
                  <Popconfirm title={`删除 /${draft.originalName}？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true, autoInsertSpace: false }} onConfirm={() => void remove()}>
                    <Button danger autoInsertSpace={false} data-testid="command-delete">删除</Button>
                  </Popconfirm>
                ) : null}
                <Button className={styles.saveButton} type="primary" data-testid="command-save" disabled={Boolean(error) || !dirty} loading={saving} onClick={() => void save()}>保存命令</Button>
              </div>
            </>
          ) : (
            <div className={styles.empty}>选一条命令，或点「新建命令」</div>
          )}
        </div>
      </div>
    </>
  );
}
