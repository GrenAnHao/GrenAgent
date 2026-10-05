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
  "github",
] as const;

// 写入工具：直接写文件或调用数据服务，不经 safety 的 write/edit 路径检查（SAFETY_WRITE_ALLOW），
// 故 readonly 模式必须单独拦截，否则 fs 隔离可被它们绕过。
export const WRITE_TOOLS = ["ast_edit", "hl_edit"] as const;

// 代码执行工具——均在宿主进程执行（py_run/js_run 走常驻内核：node:vm 可逃逸 / python 子进程；
// dap_* 启动/求值被调试程序）。ask 策略下需对其二次确认；能力闸（受限 fs / 受限 IM 会话）按此整体 deny。
export const CODE_EXEC_TOOLS = ["py_run", "js_run", "dap_launch", "dap_evaluate"] as const;
