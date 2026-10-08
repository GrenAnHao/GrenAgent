import { styleManager } from 'antd-style';

/**
 * antd-style 默认实例（key acss，@lobehub/ui 和我们的 createStyles 都用它）写死 speedy: false：
 * 每条规则一个 <style> 标签，跑一会儿 head 里就有两千多个。每插一个标签整页重算样式，
 * antd 注入 cssinjs 时还要把 head 的子节点全扫一遍（rc-util findStyles）。
 * 切会话、悬停会话行挂上新组件时，这两项占了长帧的大头。
 *
 * 打开 speedy 后规则用 insertRule 写进同一个标签。要赶在其它模块求值前调用（见 installSpeedyStyles）；
 * 之前已经插入的规则不受影响，之后的规则接在最后一个标签里。
 */
export function enableSpeedyStyles(): void {
  styleManager.sheet.isSpeedy = true;
}
