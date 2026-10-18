/**
 * 受限运行不把凭据类环境变量带进沙箱命令：沙箱目前没有网络围栏，带进去就能直接外发。
 * 按变量名匹配，只能降低风险，不是边界。
 * 放行名单是 Pi 自己的内部变量：PI_HUMAN_ORIGIN_TOKEN 是 0/1 标志，PI_BASH_COMMAND / PI_SANDBOX_CWD 是 Windows 受限运行带进去的命令和工作目录。
 * 不能按 PI_ 前缀放行，否则用户自己设的 PI_OPENAI_API_KEY 之类会绕过过滤。Windows 环境变量名不区分大小写，
 * 比较时统一转大写。
 */
const SECRET_NAME = /(TOKEN|SECRET|PRIVATE_KEY|API_KEY|PASSWORD)/i;
const INTERNAL_ALLOW: ReadonlySet<string> = new Set(["PI_HUMAN_ORIGIN_TOKEN", "PI_BASH_COMMAND", "PI_SANDBOX_CWD"]);

const GIT_SAFE_DIRECTORY_KEY = "safe.directory";

/**
 * Windows 沙箱里命令以 PiSandbox 运行，工作区归真实用户所有，git 的所有权检查会让工作区里每条 git 命令都报
 * "detected dubious ownership"。用 git 自己的环境变量配置（命令行级，safe.directory 只认这一级和系统/全局级）
 * 信任工作区本身和它下面的仓库，不放开其他路径，也不用 `*`。已有的 GIT_CONFIG_COUNT 之后追加，不覆盖调用方传的配置。
 * git 比较时用正斜杠、不带结尾斜杠；`/*` 结尾的写法要 git 2.46 以上才认，更老的版本只信工作区本身。
 */
export function withGitSafeDirectory(env: NodeJS.ProcessEnv, workspaceRoot: string): NodeJS.ProcessEnv {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const trusted = [root, `${root}/*`];
  const result: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(start + trusted.length) };
  trusted.forEach((value, offset) => {
    result[`GIT_CONFIG_KEY_${start + offset}`] = GIT_SAFE_DIRECTORY_KEY;
    result[`GIT_CONFIG_VALUE_${start + offset}`] = value;
  });
  return result;
}

export function filterSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!INTERNAL_ALLOW.has(key.toUpperCase()) && SECRET_NAME.test(key)) continue;
    result[key] = value;
  }
  return result;
}
