# 安全 Wiki 死导航与原任务恢复：定向交审

## 决定与当前状态

用户已确认：合法、安全但不在冻结页面集合中的 Wiki 导航只去掉点击包装，保留 Markdown 标签正文，记录 `UNKNOWN_WIKI_LINK` 页面和安全目标；非法/越根路径、没有 Read 证据的源码、缺少必需页仍失败。直接调用 strict validator 验证未经规范化的未知链接仍失败。明确保留代码示例，不推断或重定向页面。继续当前 `f2cca0ce-1ed0-4687-9f2f-c4b6b71a0f93`，不新开任务、不重置预算；由根代理在审查后处理。现有实跑仍未完成，未在本轮调用模型或操作用户任务。

## 实现

- 新生成或候选复验时 AST 消除安全死导航并将 warning 放入 payload；保留嵌套 Markdown 标记。已知源码路径未读到、协议/绝对路径/越根目标不做此降级；原显式 source 无法核实时保留既有纯文字合同。
- 出版对有 inputManifest 的 checkpoint 对比原正文/来源、input/output hash、evidence 与依赖，v2 原 completion manifest 和 checkpoint 哈希先行验证。随后按原 Read evidence 对原产物执行来源及导航规范化，再严格校验；保留原 outputHash，另记 normalizedBodyHash，出版 intent 包含最终机器正文。无 manifest 的旧直接调用维持原入口。已发布结果的 warning 通过 inputManifest 保留到后续增量复用。
- 恢复时 v1/v2 在新建 attempt 前，按自身 failed 候选的输入哈希、已准备依赖、同源 Read evidence 和当前 fence 先本地复验；通过时原 attempt 不变、原预算不变，原行变 prepared；失败仍遵循既有 attempt/预算，不造额度。

## 验证

- `navigation-policy-red.log`、`navigation-resume-red.log`、`navigation-evidence-red.log`、`navigation-integrity-red.log` 分别复现未知导航、耗尽 attempt 的自身候选、缺失证据与原产物篡改问题。
- `navigation-integration-final.log`：9/9 双 OS child、真实 Pi SDK/Read、loopback 测试通过。安全 unknown 正向出版 1 项；v1/v2 越根硬失败、候选落账及仅坏页模型 repair 2 项；父候选本地 repair HTTP 0 2 项；同任务 failed 候选本地 resume HTTP 0 且 attempt 不变 2 项；旧 prepared 原哈希保留并规范化后出版 HTTP 0 2 项。原四条 hard-failure fixture 已由安全 missing-page 改为越根路径，未以旧 GREEN 冒充新规则验证。
- `navigation-incremental-green.log`：安全降级页面完整出版后修改无关源码，增量更新不重发任何 generate，warning 保留。
- `navigation-core-final.log`：validation/store/projectPort 42 项通过；`navigation-projectport-final.log`：最终 checkpoint 完整性变更后 projectPort 9 项通过；`navigation-validation-final.log` 与单项复测覆盖最终 warning 页归属检查；`navigation-typecheck-final.log`：KnowledgeKernel 类型检查通过。相应用例、9 份 `navigation-*.json` 留存；限定文件 `git diff --check` 通过。
- 只读 `navigation-real-preflight.json`：父 4c12 的 10 份 prepared 和当前 f2 的 upstream 候选共 11/11，按各自冻结 snapshot、匹配 Read evidence、16 页集合运行当前生产规范化与严格校验，全通过；原 payload hash 一致。旧稿 7 条、upstream 1 条安全 warning。upstream input_hash 与父相同，当前依赖 hash 均匹配，attempt=1；最终仍由运行期 graph/fence 校验。
- `verify-published-files.mjs` 是根代理在真实任务 completed 后执行的只读入口，读取原始正式文件而非取得 ProjectFiles 锁；验证 receipt/namespace、16 页、正文、来源范围与源码 hash、warnings。`verify-published-fixture.log` 记录 16 页临时正例、空正文和源码变化反例；尚未读取真实正式文件。

`navigation-policy.diff` 相对本轮开始的工作区，只含本轮代码、测试和 note；`navigation-real-preflight.ts` 与正式文件检查脚本在 evidence 目录独立留存。真实验收是否完成由根代理在复核和用户授权后判断。
