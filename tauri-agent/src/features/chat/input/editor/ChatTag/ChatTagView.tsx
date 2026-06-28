import { Icon } from '@lobehub/ui';
import { Link2, ToyBrick } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import FileIcon from '../../../../../components/FileIcon';
import { CATEGORY_ICON as CMD_CATEGORY_ICON, COMMAND_ICON } from '../../commandIcons';
import type { ChatTagCategory, ChatTagCommandGroup } from './types';

/**
 * chip 只拿得到命令名（value），拿不到 source/apiSource：技能命令（`skill:` 前缀）用技能图标，
 * 已知系统命令用按功能匹配的图标，其余回退通用命令图标。和 slash 菜单的取图标口径保持一致。
 */
function commandIcon(value: string): LucideIcon {
  if (value.startsWith('skill:')) return CMD_CATEGORY_ICON.skill;
  return COMMAND_ICON[value.toLowerCase()] ?? ToyBrick;
}

// chip 风格：彩色文字 + 同色低透明背景。背景用 color-mix(主题色, transparent) 生成，
// 暗/亮主题下都能与气泡背景拉开对比，避免纯文字标签在暗色下「发灰发暗」难辨认。
const styles = createStaticStyles(({ css }) => ({
  tag: css`
    user-select: none;

    display: inline-flex;
    gap: 3px;
    align-items: center;
    vertical-align: -2px;

    padding: 0 5px;
    border-radius: 5px;

    font-weight: 500;
    line-height: 1.6;
  `,
  file: css`
    color: ${cssVar.colorInfo};
    background: color-mix(in srgb, ${cssVar.colorInfo} 14%, transparent);
  `,
  directory: css`
    color: ${cssVar.colorSuccess};
    background: color-mix(in srgb, ${cssVar.colorSuccess} 14%, transparent);
  `,
  command: css`
    color: ${cssVar.purple};
    background: color-mix(in srgb, ${cssVar.purple} 16%, transparent);
  `,
  toolCommand: css`
    color: #bce641;
    background: color-mix(in srgb, #bce641 16%, transparent);
  `,
  link: css`
    color: ${cssVar.cyan};
    background: color-mix(in srgb, ${cssVar.cyan} 16%, transparent);
  `,
}));

/** lobehub ActionTag 风格的行内彩色标签：图标 + 文本，按类别着色；命令按功能取图标。 */
export function ChatTagView({
  category,
  commandGroup,
  label,
  value,
}: {
  category: ChatTagCategory;
  commandGroup?: ChatTagCommandGroup;
  label: string;
  value: string;
}) {
  // 工具命令(extension) chip 用 #BCE641 突出；其它命令/文件/目录沿用各自类目色。
  const colorClass =
    category === 'command' && commandGroup === 'extension' ? styles.toolCommand : styles[category];
  const fileName = label.split('/').pop() || label;
  const isFileLike = category === 'file' || category === 'directory';
  return (
    <span className={cx(styles.tag, colorClass)} title={category === 'link' ? value : undefined}>
      {isFileLike ? (
        <FileIcon fileName={fileName} isDirectory={category === 'directory'} size={13} variant="raw" />
      ) : (
        <Icon icon={category === 'link' ? Link2 : commandIcon(value)} size={13} />
      )}
      <span>{label}</span>
    </span>
  );
}
