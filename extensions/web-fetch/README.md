# pi-web-fetch

为 [Pi coding agent](https://github.com/earendil-works/pi) 写的**网页抓取扩展**。

让 agent 不用 `bash`/`curl` 就能抓取 http(s) 网页,并转成 markdown(或纯文本)读取——适合查文档、读文章、看 API 参考 / release notes。**零第三方依赖**(Node 内置 `fetch` + 正则),带 SSRF 防护、超时和输出截断。

## 能力

| 类型 | 名称 | 说明 |
|---|---|---|
| 工具(LLM 可调) | `fetch_url` | 抓取一个 `url`。`format` 决定结果：`markdown`(默认,多提供商爬虫)、`text`(直接 HTTP,去标签)、`html`(原始 HTML)、`json`(解析后的 JSON 文本)、`llms`(探测 `<origin>/llms.txt`,`full:true` 时优先 `llms-full.txt`)。文档站先用 `format=llms`。`headers` 只对 `text` / `html` / `json` 生效。 |

## 安装 / 加载

```bash
pi -e ./extensions/web-fetch/index.ts
# 或放入 ~/.pi/agent/extensions/ 自动发现,或 pi install
```

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FETCH_MAX_CHARS` | `0` | 喂给模型的最大字符数。`0`=不截断(返回全文)。设为 >0 时:超长页面只把 **head+tail 预览**喂给模型,并把**全文落盘**到 `<cwd>/.pi/web-fetch/<id>.md`,模型可用 `read`/`grep` 按需读回被省略的中间部分(落盘文件 7 天后自动清理)。 |
| `FETCH_TIMEOUT_MS` | `15000` | 请求超时(毫秒) |

## 安全(SSRF 防护)

`fetch_url` 只允许 http/https,并拒绝指向本机/内网的地址:`localhost`、`127.*`、`10.*`、`192.168.*`、`172.16-31.*`、`169.254.*`、IPv6 回环/链路本地/ULA。

> 注:这是基于主机名的基础防护,**不防 DNS rebinding**。若部署在能访问敏感内网的环境,建议在网络层再加出站白名单。

## 用法示例

```text
> 读一下 https://github.com/earendil-works/pi 的 README,总结 Pi 的扩展机制
  (agent 调 fetch_url 抓取并阅读后回答)
```

## 文件结构

```text
web-fetch/
├── index.ts       # fetch_url（format: markdown / text / html / json / llms）
├── fetcher.ts     # 直接 HTTP 抓取(mcp-npx-fetch 能力对齐)
├── html.ts        # HTML → markdown / text 转换 + isSafeUrl
├── truncate.ts    # head+tail 截断 + llms.txt 响应校验
├── package.json
└── README.md
```

## 进阶扩展点

1. **更好的正文提取**:接 `@mozilla/readability` + `jsdom` 做主内容抽取(需加依赖),去掉导航/页脚噪音。
2. **缓存**:对同一 URL 加本地缓存，减少重复抓取。
3. **截图/PDF**:接 headless 浏览器抓动态页面。

## 注意

- 包名按官方新名 `@earendil-works/*` + `typebox` 写;旧包改 `index.ts` 顶部 import。
- 纯正则解析对结构怪异的页面可能不完美,够喂给 LLM 阅读即可。
