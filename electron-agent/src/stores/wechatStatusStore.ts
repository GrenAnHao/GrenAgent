import { create } from 'zustand';

/** 微信(ilink) 实时状态（由 sidecar im-platforms 扩展经 setStatus("wechat") 推送）。 */
export interface WechatStatus {
  enabled: boolean;
  loggedIn: boolean;
  /** idle | disabled | starting | waiting-scan | confirmed | ... */
  status: string;
  /** 待扫码时的二维码图片链接。 */
  qrLink?: string;
}

interface WechatStatusState {
  wechat: WechatStatus;
  setWechat: (wechat: WechatStatus) => void;
}

export const useWechatStatusStore = create<WechatStatusState>((set) => ({
  wechat: { enabled: false, loggedIn: false, status: 'idle' },
  setWechat: (wechat) => set({ wechat }),
}));
