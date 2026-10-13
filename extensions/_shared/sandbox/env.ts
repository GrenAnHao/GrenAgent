/**
 * 受限运行不把凭据类环境变量带进沙箱命令：沙箱目前没有网络围栏，带进去就能直接外发。
 * 按变量名匹配，只能降低风险，不是边界。
 * 放行名单是 Pi 自己的内部变量：PI_HUMAN_ORIGIN_TOKEN 是 0/1 标志，PI_SANDBOX_CWD_GUARD 携带 cwd 守卫脚本。
 * 不能按 PI_ 前缀放行，否则用户自己设的 PI_OPENAI_API_KEY 之类会绕过过滤。Windows 环境变量名不区分大小写，
 * 比较时统一转大写。
 */
const SECRET_NAME = /(TOKEN|SECRET|PRIVATE_KEY|API_KEY|PASSWORD)/i;
const INTERNAL_ALLOW: ReadonlySet<string> = new Set(["PI_HUMAN_ORIGIN_TOKEN", "PI_SANDBOX_CWD_GUARD"]);

export function filterSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!INTERNAL_ALLOW.has(key.toUpperCase()) && SECRET_NAME.test(key)) continue;
    result[key] = value;
  }
  return result;
}
