import { useMemo, useState } from 'react';
import { Icon, Popover } from '@lobehub/ui';
import { App } from 'antd';
import { cssVar, cx } from 'antd-style';
import { Check, FileDiff, GitBranch, GitBranchPlus, Network, Search } from 'lucide-react';
import { pi } from '../../../../lib/pi';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useGitInfo, useGitStore } from '../../../../stores/gitStore';
import { ChangesModal } from './DiffPanel';
import { GitGraphModal } from './GitGraphPanel';
import { wsStyles as s } from './styles';

/**
 * 分支选择器：当前分支 + 未提交改动数徽标；点开下拉可搜索 / 切换 / 创建并检出新分支。
 * 切换与创建走后端 git_checkout / git_create_branch，完成后强制刷新 gitStore 并关闭。
 */
export function BranchPicker() {
  const { workspace } = useAgentStoreContext();
  const { message } = App.useApp();
  const git = useGitInfo(workspace);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);

  const changes = git.changes.length;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? git.branches.filter((b) => b.name.toLowerCase().includes(q)) : git.branches;
  }, [git.branches, query]);

  const refresh = () => useGitStore.getState().load(workspace, true);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      void refresh();
    } else {
      setCreating(false);
      setNewName('');
      setQuery('');
    }
  };

  const onCheckout = async (branch: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await pi.gitCheckout(workspace, branch);
      await refresh();
      setOpen(false);
    } catch (e) {
      message.error(`切换分支失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await pi.gitCreateBranch(workspace, name, true);
      await refresh();
      setOpen(false);
    } catch (e) {
      message.error(`创建分支失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setCreating(false);
      setNewName('');
    }
  };

  const content = (
    <div className={s.panel}>
      <div className={s.search}>
        <Icon icon={Search} size={13} />
        <input
          autoFocus
          placeholder="搜索分支"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={s.list}>
        {filtered.length === 0 ? (
          <div className={s.empty}>无匹配分支</div>
        ) : (
          filtered.map((b) => (
            <div
              key={b.name}
              className={cx(s.row, b.isCurrent && s.rowSel)}
              onClick={() => {
                if (!b.isCurrent) void onCheckout(b.name);
              }}
            >
              <Icon className={s.iconMuted} icon={GitBranch} size={13} />
              <span className={s.rowName}>
                {b.name}
                {b.isCurrent && changes > 0 ? (
                  <div className={s.rowSub}>未提交的更改：{changes} 个文件</div>
                ) : null}
              </span>
              {b.isCurrent ? (
                <Icon icon={Check} size={13} style={{ color: cssVar.colorPrimary }} />
              ) : null}
            </div>
          ))
        )}
      </div>
      <div className={s.foot}>
        {changes > 0 ? (
          <div
            className={s.footRow}
            data-testid="branch-view-changes"
            onClick={() => {
              setOpen(false);
              setDiffOpen(true);
            }}
          >
            <Icon icon={FileDiff} size={13} />
            <span className={s.rowName}>查看改动（{changes}）</span>
          </div>
        ) : null}
        <div
          className={s.footRow}
          data-testid="branch-view-graph"
          onClick={() => {
            setOpen(false);
            setGraphOpen(true);
          }}
        >
          <Icon icon={Network} size={13} />
          <span className={s.rowName}>Git 图谱</span>
        </div>
        {creating ? (
          <div className={s.search} style={{ border: 'none', padding: '4px 6px' }}>
            <Icon icon={GitBranchPlus} size={13} />
            <input
              autoFocus
              placeholder="新分支名，回车创建"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onCreate();
                if (e.key === 'Escape') setCreating(false);
              }}
            />
          </div>
        ) : (
          <div className={s.footRow} onClick={() => setCreating(true)}>
            <Icon icon={GitBranchPlus} size={13} />
            <span className={s.rowName}>创建并检出新分支…</span>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Popover
        arrow={false}
        content={content}
        open={open}
        placement="topLeft"
        trigger="click"
        onOpenChange={onOpenChange}
      >
        <span className={s.chip}>
          <Icon icon={GitBranch} size={14} />
          <span className={s.chipName}>{git.current || '—'}</span>
          {changes > 0 ? <span className={s.badge}>{changes}</span> : null}
        </span>
      </Popover>
      <ChangesModal workspace={workspace} open={diffOpen} onClose={() => setDiffOpen(false)} />
      <GitGraphModal workspace={workspace} open={graphOpen} onClose={() => setGraphOpen(false)} />
    </>
  );
}
