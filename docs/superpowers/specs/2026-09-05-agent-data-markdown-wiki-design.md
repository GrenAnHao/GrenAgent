# AgentData Markdown Wiki

日期：2026-09-05

状态：用户已确认按 Markdown 正文主存储、SQLite 索引与状态的方向继续。

## 依据与边界

参考本机 `D:/System Dir/Downloads/TencentDB-Agent-Memory/MemoryKnowledge`：`wiki-service.ts` 的页面读写直接操作 `.md`；`engines/wiki/index-db.ts` 的 `page_meta` 不保存正文；索引可以扫描页面重建。

Pi 保留单用户本地架构，不引入该参考项目的 service/team 多租户、云端资产授权、向量服务或图谱多跳检索。沿用现有 AgentData RPC 和项目/全局查询范围。

## 正文与索引

- 页面真实写入 `<应用数据目录>/wiki/<工作区稳定标识>/wiki/`，原始资料快照放在同级 `raw/sources/`。
- 保存工作区映射信息，保证脱离原 SQLite 索引仍能从目录恢复页面来源。
- Markdown frontmatter 保存页面标识、标题、来源、更新时间与人工锁定标记；正文可由用户直接编辑。
- `wiki.read` 从文件读取；`wiki.search` 使用衍生全文索引；`wiki.list` 返回页面摘要和真实路径。
- `wiki.reindex` 仅扫描 Markdown 并重建元数据/FTS，不调用模型、不重新生成正文。删除页面文件后重建索引应移除相应结果。
- `locked: true` 的人工页面不会被自动生成覆盖。

## 兼容与失败

- 保留旧 `wiki_pages` 正文，作为只读迁移来源；幂等导出到 Markdown，不删除原记录。
- 已存在文件不覆盖。迁移进度持久化，文件后续被用户删除不能在重启时被旧库重新导出。
- 兼容旧页面标识含/不含 `.md` 的情况，处理路径碰撞时保留所有内容。
- 写入和索引失败时保留上一版本可读；允许随后无模型重建索引修复衍生状态。
- 工作区之间隔离，页面与原文路径不能逃离所属 Wiki 目录，拒绝外部目录链接。

## 扩展交互

保留 `wiki_search` / `wiki_update`；增加 `wiki_read` / `wiki_list` / `wiki_reindex`。更新保存读取时的原文快照，生成结果成功且未取消时才提交正文。写入和重建遵守已有 Electron 权限机制。

## 验证

使用临时目录、临时 SQLite 与真实回环 RPC，验证实际落盘、原文快照、页面读取、文件编辑后重建、删除后去索引、索引丢失恢复、旧库导出幂等、冲突不覆盖、人工锁定、路径穿越与取消。模型只使用可控测试替身，不访问真实付费服务。
