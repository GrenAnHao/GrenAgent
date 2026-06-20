// 副作用工具分组：单一真相源。safety 的逐工具门控与 multi-agent / im-platforms 的能力闸
// 共用同一份清单，避免两处各自维护工具名而漂移失配——历史上 NET_TOOLS 曾误写成不存在的
// web_fetch / web_crawler，导致 ask 联网确认与 net:false 几乎只命中 web_search 一个。
//
// 新增联网/写盘/执行类工具时，在此登记一次，safety 与能力闸即同步生效。

// 联网工具（web-search / web-fetch / github 扩展实际注册的工具名）。
export const NET_TOOLS = [
  "web_search",
  "web_search_multi",
  "fetch_url",
  "fetch_llms",
  "fetch_html",
  "fetch_markdown",
  "fetch_txt",
  "fetch_json",
  "fetch_github_readme",
  "fetch_web_content",
  "github",
] as const;

// 写盘工具：直接 writeFileSync 写文件，不经 safety 的 write/edit 路径检查（SAFETY_WRITE_ALLOW），
// 故 readonly 模式必须单独拦截，否则 fs 隔离可被它们绕过。
export const WRITE_TOOLS = ["ast_edit", "hl_edit"] as const;

// 代码执行工具——沙箱可用时进 WSL2 沙箱（受限）、不可用时在宿主直跑（node:vm 可逃逸 / python 子进程）。
export const SANDBOXABLE_EXEC_TOOLS = ["py_run", "js_run", "sandbox_sh"] as const;

// 沙箱不可用时回退到宿主内核执行的代码工具（ask 策略需对其二次确认）。
// sandbox_sh 不在此列：它不回退，沙箱不可用时直接返回「不可用」不执行。
export const HOST_FALLBACK_EXEC_TOOLS = ["py_run", "js_run"] as const;

// 代码执行工具——总在宿主执行、不经沙箱（调试器启动被调试程序 / 求值表达式）。
export const HOST_ONLY_EXEC_TOOLS = ["dap_launch", "dap_evaluate"] as const;

// 全部代码执行工具（能力闸按此整体 deny）。
export const CODE_EXEC_TOOLS = [
  "py_run",
  "js_run",
  "sandbox_sh",
  "dap_launch",
  "dap_evaluate",
] as const;
