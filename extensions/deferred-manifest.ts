// embedded-runner 不能静态 import ./index.js：index 加载 multi-agent，multi-agent 再加载
// embedded-runner。直接 dynamic import ./index.js 也不会拆 chunk：index 已经在同一条静态图里，
// rolldown 报 INEFFECTIVE_DYNAMIC_IMPORT。这个文件只被动态引用，调用时才把环接上。
export { manifestExtensions } from "./index.js";
