# Atlas Service — TypeScript 离线示例
纯 TypeScript 任务业务层：API adapter → domain service → optimistic store；持久化成功后发事件。它不启动网络或执行外部代码，用作 RepoWiki 源码证据和实际业务单元测试。
在工程根目录运行 `npm run test:example`。此示例内存存储不是生产数据库，也不模拟 AI。
