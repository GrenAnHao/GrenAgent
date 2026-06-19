// 受保护路径单一真相源：safety 的 write/edit 拦截，以及"绕过型"写工具（ast_edit/hl_edit
// 直接 writeFileSync、不经 safety 的 write/edit 路径）在写盘前的自检，共用同一份清单——
// 否则各处各维护一份会漂移，留下"某个写工具能写 .env/.git/keys"的缺口。
//
// 命中规则（大小写不敏感，兼容 \\ 与 / 分隔符）：
//   .env / .env.*（但放过 write/edit 调用者自行决定的其它点文件）
//   .git 目录内任意文件
//   node_modules 目录内任意文件
//   *.pem / *.key 私钥证书
const PROTECTED = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /\.(pem|key)$/i,
];

/** True if writing to `p` should be blocked as a protected path. */
export function matchProtectedPath(p: string): boolean {
  if (!p) return false;
  return PROTECTED.some((re) => re.test(p));
}
