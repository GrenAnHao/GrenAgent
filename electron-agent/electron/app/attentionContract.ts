/**
 * 会话注意状态的主进程 / 渲染层共用契约：通知类别、设置键与默认值、IPC 载荷、推送事件名。
 * 渲染层的设置页和侧栏都从这里读，主进程判断开关也读这里，默认值只有一份。
 * 渲染层会直接 import 这里的值：只能是纯 TS，禁止引入 node / electron 依赖。
 */

/** 和渲染层 sessionControlKey 同一种归一：分隔符、长路径前缀、末尾斜杠、大小写不同算同一个会话。 */
export function attentionSessionKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
}

export const ATTENTION_KINDS = ['approval', 'choice', 'failed', 'blocked', 'done'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export type NotifySettingKey =
  | 'notify.done'
  | 'notify.choice'
  | 'notify.blocked'
  | 'notify.failed'
  | 'notify.sound'
  | 'notify.taskbar';

/** 完成默认不提醒，其余默认开。 */
export const NOTIFY_SETTING_DEFAULTS: Record<NotifySettingKey, '0' | '1'> = {
  'notify.done': '0',
  'notify.choice': '1',
  'notify.blocked': '1',
  'notify.failed': '1',
  'notify.sound': '1',
  'notify.taskbar': '1',
};

export function isAttentionKind(value: unknown): value is AttentionKind {
  return typeof value === 'string' && (ATTENTION_KINDS as readonly string[]).includes(value);
}

/** 「需要选择」开关同时管选项卡和审批。 */
export function notifySettingOf(kind: AttentionKind): NotifySettingKey {
  return kind === 'approval' || kind === 'choice' ? 'notify.choice' : `notify.${kind}`;
}

/** 空值或没写过取默认；只有 '1' 算开。 */
export function notifyEnabled(settings: Record<string, string>, key: NotifySettingKey): boolean {
  const raw = settings[key];
  const value = raw === undefined || raw === '' ? NOTIFY_SETTING_DEFAULTS[key] : raw;
  return value === '1';
}

export interface AttentionNotifyInput {
  kind: AttentionKind;
  workspace: string;
  sessionPath: string;
  title: string;
  body: string;
}

export interface AttentionNotifyResult {
  /** off：这一类关着；in-app：窗口在前台，由渲染层弹应用内提示；os：已发系统通知。 */
  route: 'off' | 'in-app' | 'os';
  sound: boolean;
}

/** payload { focused: boolean } */
export const WINDOW_FOCUS_EVENT = 'pi://window-focus';
/** payload { workspace: string; sessionPath: string } */
export const ATTENTION_OPEN_EVENT = 'pi://attention-open';
