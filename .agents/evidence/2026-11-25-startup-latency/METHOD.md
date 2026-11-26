# GrenAgent 冷启动：会话库扫描与首屏

## 测的是什么

每轮新起一个独立的 Windows Electron 进程，运行本机实际代码的 localrun 构建（生产模式渲染层、真实主进程、真实 Agent 子进程和 SDK）。旧版在本次优化开始前从**当时的未提交工作区**复制，不拿较早的 Git HEAD 冒充。新版采用相同构建入口及依赖。两者不读写工作区原有的 out、dist、真实配置、历史或桌面实例。隐藏 1200×800 窗口，禁用后台节流，禁止渲染层访问外网；没有发送模型消息。计时不含源码构建。未清空操作系统文件缓存；表示进程冷启动，不表示机器刚重启后的冷盘。

合成库复用了本机目录项的**长度分布**，没有读取真实聊天正文。32 个项目目录、1,458 份 JSONL，初始 1,779,110,578 字节；填充为合法 JSONL 记录，约四分之三是合成子代理。已记住的目标是短会话（初始 8,731 字节），真实 SDK 首次打开时补入 916 字节本地状态，之后库稳定在 1,779,111,494 字节（1.657 GiB）。侧栏应返回 365 份可见会话。这里测的是**大量其他历史不应阻塞短会话**，不把超长目标会话自身的渲染时间混入结果。

- **进程到可输入**：父探针启动 Electron 至记住的用户消息出现、Logo 不拦输入，探针通过真实 Electron 鼠标点输入框并插入不发送的本轮标记，再从真实编辑器回读成功。不是“窗口已建”或“显示空编辑器”。
- **Logo 等待/完全退场**：从 HTML 的品牌节点插入，到它开始淡出/被移除；`logoInput` 是从同一节点插入到上述回读成功。各时间点独立记录，正文、Logo 和编辑器不会总在同一帧完成。
- **列表**：记录真实主进程第一次 `list_all_sessions` IPC 起止、返回条数和目标是否在其中。`listDuration` 是 IPC 耗时，`listEnd` 是从拉起进程到目录返回的用时；不是侧栏每项已完成绘制。旧版并发发两次、共享同一缓存，不能把两个时长相加。新版本另记精确目标查询 `lookup_startup_session`。
- **空缓存/已有缓存**：仅移走隔离数据里的 `session-summaries.v1.json`，保留相同合成 JSONL、同一活动项目、同一模型和前端配置；旧版本没有该持久化缓存。交错三组次序为旧/空/有、有/旧/空、空/有/旧。每组都是顺序新起进程，避免两份应用互抢 I/O。
- **外部变更**：单独的 `io-*` 运行仅在主进程计数 `fs.promises.readFile` 对合成会话 JSONL 的整份读取（不含 stat、头部读取、SDK 子进程读目标）。一轮在应用已关闭后从外部修改另一份 JSONL 的标题，然后新起进程读出新标题。该组带 I/O 探针，与主计时分开。
- 首个探针曾生成无父节点的尾部填充条目，导致 SDK 恢复标题却没有真实正文。baseline-1.json 明确失败，不计可用时间；生成器已修正活动会话填充。baseline-2 是修正后首次成功的旧版启动，保留在总统计；其余有效慢样本全部保留。外网字体被测试环境拦截，个别非关键会话状态查询发生租约竞争；有后续正确正文、成功输入和完整列表才判定本次有效。

## 复用测法

Windows，仓库现有依赖已装好。sizes.json 只含按匿名目录分组的文件大小，不需要真实历史。下例从证据目录运行，在各自版本就绪时调用 snapshot.ps1；不要在两次快照之间更换共享依赖。

```powershell
$tmp = Join-Path $env:TEMP ('gren-boot-bench-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
node bench.mjs make $tmp
.\snapshot.ps1 -Scratch $tmp -Tag before   # 优化前的源树
node bench.mjs prepare $tmp before
node bench.mjs run $tmp before my-before
.\snapshot.ps1 -Scratch $tmp -Tag after    # 优化后的源树
node bench.mjs prepare $tmp after
node bench.mjs run $tmp after my-first
node bench.mjs run $tmp after my-cached
```

prepare 只给快照加隐藏窗口、隔离路径和时间观察器，run 每次新起 Electron，标签不能覆盖已有结果。要分别测多次空缓存，进程退出后把隔离 home/.pi/agent/session-summaries.v1.json 移到临时目录的其他文件名，不删除源 JSONL。所有原始计时在同名 JSON；summarize.mjs 生成 timings.json，含每轮数值和分组中位数。原始应用控制台只存于临时目录，不是报告的外部依赖。
