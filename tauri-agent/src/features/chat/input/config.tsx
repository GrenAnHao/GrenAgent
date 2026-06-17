import type { ComponentType } from 'react';
import ModelAction from './actions/ModelAction';
import ThinkingAction from './actions/ThinkingAction';
import CompactAction from './actions/CompactAction';
import NewSessionAction from './actions/NewSessionAction';
import UploadAction from './actions/UploadAction';
import KbAddAction from './actions/KbAddAction';
import WebSearchAction from './actions/WebSearchAction';
import GenerateImageAction from './actions/GenerateImageAction';
import SpeakAction from './actions/SpeakAction';

/**
 * 动作注册表：key -> 组件。
 * 新增一个工具按钮 = 在此登记一项 + 在 leftActions/rightActions 数组里加 key。
 */
export const actionMap = {
  model: ModelAction,
  thinking: ThinkingAction,
  compact: CompactAction,
  newSession: NewSessionAction,
  fileUpload: UploadAction,
  kbAdd: KbAddAction,
  webSearch: WebSearchAction,
  generateImage: GenerateImageAction,
  speak: SpeakAction,
} satisfies Record<string, ComponentType>;

export type ActionKey = keyof typeof actionMap;

/**
 * 折叠进「更多」菜单时展示的文字标签（与各 action 组件的 title 对应）。
 * 工具栏里图标悬停有 tooltip，但折进竖排菜单后不易辨认，故菜单里图标旁补一行文字。
 */
export const ACTION_LABELS: Record<ActionKey, string> = {
  model: '模型',
  thinking: '思考强度',
  compact: '压缩上下文',
  newSession: '新会话',
  fileUpload: '添加图片',
  kbAdd: '加入知识库',
  webSearch: '联网搜索',
  generateImage: '生成图片',
  speak: '朗读文本',
};

export const DEFAULT_LEFT_ACTIONS: ActionKey[] = [
  'model',
  'thinking',
  'fileUpload',
  'kbAdd',
  'webSearch',
  'generateImage',
  'speak',
  'compact',
  'newSession',
];
export const DEFAULT_RIGHT_ACTIONS: ActionKey[] = [];

/**
 * 工具栏空间不足时的折叠优先级：靠前者先被收进"更多"溢出菜单。
 * 不在此列表中的 key（如 model）视为主控件，永不折叠。
 */
export const COLLAPSE_PRIORITY: ActionKey[] = [
  'speak',
  'generateImage',
  'webSearch',
  'kbAdd',
  'compact',
  'newSession',
  'fileUpload',
  'thinking',
];

/**
 * 各控件渲染宽度的估算值（px，含约 2px 行内间距），用于无需挂载组件即可计算溢出。
 * model 取限宽后的上限（见 ModelAction 的 maxWidth），按最坏情况预留以避免溢出。
 */
export const ACTION_WIDTH = {
  model: 140,
  thinking: 84,
  fileUpload: 28,
  kbAdd: 28,
  webSearch: 28,
  generateImage: 28,
  speak: 28,
  compact: 28,
  newSession: 28,
} satisfies Record<ActionKey, number>;

/** "更多"溢出按钮自身的宽度，折叠发生时计入预留。 */
export const MORE_BUTTON_WIDTH = 32;
