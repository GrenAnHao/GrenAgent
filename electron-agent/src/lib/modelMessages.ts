import { useSyncExternalStore } from 'react';

const zh = {
  fast: 'Fast',
  fastCheckbox: '快速',
  fastActive: '快速',
  image: '图片输入',
  reasoning: '思考（reasoning）',
  fastCapability: '支持 Fast 接入',
  fastUnsupported: '此接口尚未接入 Fast',
  fastOn: 'Fast 已开启，点击关闭。按会话记忆，不影响同项目其它会话；可能增加费用。',
  fastOff: 'Fast 已关闭，点击开启。按会话记忆，不影响同项目其它会话；可能增加费用。',
  fastLoadError: '无法读取 Fast 状态，请重试',
  fastSaveError: 'Fast 状态保存失败，请重试',
  retry: '重试',
};
const en: typeof zh = {
  fast: 'Fast',
  fastCheckbox: 'Fast',
  fastActive: 'Fast',
  image: 'Image input',
  reasoning: 'Reasoning',
  fastCapability: 'Fast access supported',
  fastUnsupported: 'Fast is not available for this API',
  fastOn: 'Fast is on. Click to turn off. Remembered per session; may cost more.',
  fastOff: 'Fast is off. Click to turn on. Remembered per session; may cost more.',
  fastLoadError: 'Could not load Fast status. Try again.',
  fastSaveError: 'Could not save Fast status. Try again.',
  retry: 'Retry',
};

export function modelMessages(locale: string): typeof zh {
  return locale.toLowerCase().startsWith('en') ? en : zh;
}

const readLocale = () => document.documentElement.lang || 'zh-CN';
function subscribeLocale(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  return () => observer.disconnect();
}

/** Centralized bilingual strings; follows the document language without a new dependency. */
export function useModelMessages(): typeof zh {
  return modelMessages(useSyncExternalStore(subscribeLocale, readLocale, () => 'zh-CN'));
}
