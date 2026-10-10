import { Button, Flexbox } from '@lobehub/ui';
import { App, Input, Popconfirm, Tooltip } from 'antd';
import { Plus, SquareSlash, TriangleAlert } from 'lucide-react';
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

interface CommandsPanelProps {
  workspace: string;
  /** 模板文件变了：让会话重载资源，新命令才会出现在 Pi 的命令表里。 */
  onResourcesChanged: () => void;
}

function draftOf(command: PromptCommandInfo): CommandDraft {
  return { originalName: command.name, name: command.name, description: command.description, body: command.body };
}

export function CommandsPanel({ workspace, onResourcesChanged }: CommandsPanelProps) {
  const { message } = App.useApp();
  const [commands, setCommands] = useState<PromptCommandInfo[]>([]);
  const [reserved, setReserved] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<CommandDraft | null>(null);
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
      await afterChange();
      message.success(`已删除 /${name}`);
    } catch (cause) {
      message.error(errorText(cause));
    }
  };

  return (
    <>
      <div className={styles.heroBar}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}><SquareSlash size={20} /></span>
          <span className={styles.heroTitle}>
            命令
            {commands.length > 0 ? <span className={styles.count}>{commands.length}</span> : null}
          </span>
        </div>
        <Button type="primary" icon={<Plus size={15} />} data-testid="command-new" onClick={() => setDraft({ ...EMPTY_COMMAND_DRAFT })}>
          新建
        </Button>
      </div>
      <div className={styles.desc}>全局命令保存在 ~/.pi/agent/prompts，在输入框打 / 选用。</div>
      <div className={styles.split}>
        <div className={styles.list} data-testid="command-list">
          {commands.length === 0 ? <div className={styles.empty}>还没有命令</div> : null}
          {commands.map((command) => (
            <button
              key={command.name}
              type="button"
              className={styles.item}
              data-testid={`command-item-${command.name}`}
              data-active={draft?.originalName === command.name}
              onClick={() => setDraft(draftOf(command))}
            >
              <CommandPillView name={command.name} args={[]} />
              {command.error ? (
                <Tooltip title={command.error}>
                  <TriangleAlert size={15} className={styles.warn} data-testid={`command-warning-${command.name}`} />
                </Tooltip>
              ) : null}
              {command.params.length > 0 ? <span className={styles.badge}>{command.params.length} 参数</span> : null}
            </button>
          ))}
        </div>
        <div className={styles.edit}>
          {draft ? (
            <>
              <div>
                <div className={styles.label}>命令名（即文件名）</div>
                <Input data-testid="command-name-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </div>
              <div>
                <div className={styles.label}>描述（菜单里显示）</div>
                <Input data-testid="command-description-input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
              </div>
              <div className={styles.fillField}>
                <div className={styles.label}>提示词</div>
                <PromptBodyEditor value={draft.body} onChange={(body) => setDraft({ ...draft, body })} />
              </div>
              <div data-testid="command-detected-params">
                <div className={styles.label}>识别到的参数</div>
                {params.length === 0 ? '无' : params.map((param, index) => (
                  <span key={param.name} className={styles.param}>
                    {index + 1}. {param.name}
                    {param.defaultValue !== undefined ? `（默认 ${param.defaultValue}）` : ''}
                  </span>
                ))}
              </div>
              {error ? <div className={styles.error} data-testid="command-error">{error}</div> : null}
              <Flexbox horizontal gap={8}>
                <Button type="primary" data-testid="command-save" disabled={Boolean(error)} loading={saving} onClick={() => void save()}>
                  保存
                </Button>
                {draft.originalName ? (
                  <Popconfirm title={`删除 /${draft.originalName}？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void remove()}>
                    <Button danger data-testid="command-delete">删除</Button>
                  </Popconfirm>
                ) : null}
              </Flexbox>
            </>
          ) : (
            <div className={styles.empty}>选一条命令，或点「新建」</div>
          )}
        </div>
      </div>
    </>
  );
}
