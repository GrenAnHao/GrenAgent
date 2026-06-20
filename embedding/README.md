# embedding —— TypeScript 极简本地向量服务（Node.js SEA 单体打包）

在本地 CPU 上用 `@huggingface/transformers` 跑 **`Xenova/bge-small-zh-v1.5`**（BAAI bge-small-zh 中文版，512 维），
对外暴露 **OpenAI 兼容** `POST /v1/embeddings`，并保留 legacy `POST /embed`。
可用 Node v25.5+ 的 `--build-sea` 打成 `vector-service.exe`。

## Pi 接入示例

在供应商库新增 provider（`models.json`）：

```json
{
  "name": "local-embed",
  "api": "openai-completions",
  "baseUrl": "http://127.0.0.1:8787/v1",
  "apiKey": "local",
  "models": [{ "id": "bge-small-zh-v1.5" }]
}
```

设置里把 `KB_EMBED_PROVIDER` / `MEMORY_EMBED_PROVIDER` 指到该 provider，`model` 填 `bge-small-zh-v1.5`。
`apiKey` 不能为空（Pi 要求），填任意占位符即可；服务端默认不校验，设 `EMBED_API_KEY` 后可启用 Bearer 校验。

**注意**：从云端 embedding（如 Jina）切到本地 512 维模型后，需重建知识库 / 记忆 / 代码索引向量。

## 目录结构

\`\`\`text
embedding/
├── vector-service.ts   # 核心：SEA 检测 + getEmbedding()
├── app.ts              # HTTP 入口（原生 http 模块）
├── sea-banner.js       # SEA 专用 banner：bundle IIFE 前重写 require
├── build.mjs           # esbuild JS API 打包脚本（读取 TS + banner）
├── tsconfig.json
├── package.json
├── sea-config.json     # SEA 配置（含 node.exe 绝对路径）
└── dist/               # esbuild 产物（构建时生成）
\`\`\`

## 0. 环境要求

- **SEA 打包需要 Node ≥ 25.5.0**：

  \`\`\`cmd
  nvm install 25.5
  nvm use 25.5.0
  \`\`\`

- 首次运行会下载模型权重。国内网络建议设置镜像：

  \`\`\`cmd
  set HF_ENDPOINT=https://hf-mirror.com
  \`\`\`

## 1. 安装依赖

\`\`\`cmd
cd embedding
npm install
\`\`\`

## 2. 类型检查

\`\`\`cmd
npm run typecheck
\`\`\`

## 3. 开发运行

\`start\` 会先用 esbuild 打包 TypeScript，再用普通 Node 跑 bundle：

\`\`\`cmd
set HF_ENDPOINT=https://hf-mirror.com
npm start
\`\`\`

测试 OpenAI 兼容接口：

\`\`\`cmd
curl -X POST http://localhost:8787/v1/embeddings ^
  -H "content-type: application/json" ^
  -H "authorization: Bearer local" ^
  -d "{\"model\":\"bge-small-zh-v1.5\",\"input\":\"你好世界\"}"
\`\`\`

Legacy 单条接口：

\`\`\`cmd
curl -X POST http://localhost:8787/embed -H "content-type: application/json" -d "{\"text\":\"你好世界\"}"
\`\`\`

OpenAI 返回格式：

\`\`\`json
{
  "object": "list",
  "data": [{ "object": "embedding", "index": 0, "embedding": [0.01, -0.02] }],
  "model": "bge-small-zh-v1.5",
  "usage": { "prompt_tokens": 0, "total_tokens": 0 }
}
\`\`\`

Legacy 返回格式（512 维）：

\`\`\`json
{
  "dim": 512,
  "vector": [0.01, -0.02],
  "model": "bge-small-zh-v1.5"
}
\`\`\`

## 4. SEA 打包完整流程

\`\`\`cmd
:: 1) TypeScript -> 单文件 CommonJS bundle
npm run build:bundle

:: 2) Node v25.5+ 生成单体可执行文件
npm run build:sea
\`\`\`

产物：

\`\`\`text
embedding/vector-service.exe
\`\`\`

## 5. 运行 exe

\`\`\`cmd
set HF_ENDPOINT=https://hf-mirror.com
vector-service.exe
\`\`\`

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `EMBED_MODEL` | `Xenova/bge-small-zh-v1.5` | transformers.js 模型 ID |
| `EMBED_OPENAI_MODEL` | `bge-small-zh-v1.5` | OpenAI 响应里的 model 字段 |
| `HF_ENDPOINT` | （无） | 设为 `https://hf-mirror.com` 加速国内下载 |
| `EMBED_API_KEY` | （无） | 设值后要求 `Authorization: Bearer <key>` |

## 关键实现点

### 1. TypeScript 源码，CommonJS 输出

源码是 \`app.ts\` / \`vector-service.ts\`，但 SEA 入口仍是 \`dist/app.bundle.js\`：

\`\`\`json
{
  "main": "dist/app.bundle.js",
  "mainFormat": "commonjs",
  "executable": "D:\\\\nvm4w\\\\nodejs\\\\node.exe",
  "output": "vector-service.exe",
  "disableExperimentalSeaWarning": true,
  "useCodeCache": true
}
\`\`\`

### 2. onnxruntime-node 必须 external

\`@huggingface/transformers\` 在 Node 后端依赖原生 \`onnxruntime-node\` \`.node\` 插件。
esbuild 不能把这种二进制插件安全地 inline 进 JS bundle，所以 \`build.mjs\` 中保留：

\`\`\`js
external: ['onnxruntime-node', 'onnxruntime-common', 'sharp']
\`\`\`

### 3. SEA require 限制用 banner 解决

Node 25 SEA 的 main script 中，默认 \`require()\` 只支持 \`node:\` 内置模块。
如果 bundle 里出现：

\`\`\`js
require('onnxruntime-node')
\`\`\`

会报：

\`\`\`text
ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: onnxruntime-node
\`\`\`

所以 \`build.mjs\` 会把 \`sea-banner.js\` 注入到 bundle IIFE **之前**。
这个 banner 在最外层重写 \`require\`：

- \`node:\` / 相对路径 / 绝对路径：交给 SEA 原始 require
- 第三方裸包名：交给 \`Module.createRequire(APP_ROOT/package.json)\`，从真实磁盘加载

这一步是 SEA 版 transformers.js 能加载 \`onnxruntime-node\` 的关键。

## 分发清单

默认方案不是“完全零依赖单文件”，因为 \`onnxruntime-node\` 原生插件和模型权重仍在磁盘：

\`\`\`text
my-app/
├── vector-service.exe
├── .models/                       # 首次运行后自动生成；可预下载
└── node_modules/onnxruntime-node/  # 原生 .node 插件，运行时需要
\`\`\`

如果要真正把 \`.node\` 与模型都塞进 exe，需要在 \`sea-config.json\` 中使用 \`assets\`，
运行时再用 \`sea.getAsset()\` 取出并落盘加载。当前版本保持极简和可验证。
