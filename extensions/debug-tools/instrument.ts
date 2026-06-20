// 多语言插桩片段：把诊断数据 POST 到本地 debug log 收集器。无 I/O，便于单测。
// agent 在 debug 模式按假设把这些片段插入关键路径，用户复现后用 debug_log(read) 读回。

export type InstrumentLang =
  | "js"
  | "ts"
  | "python"
  | "shell"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "php";

export const SUPPORTED_LANGS: InstrumentLang[] = [
  "js",
  "ts",
  "python",
  "shell",
  "go",
  "rust",
  "java",
  "ruby",
  "php",
];

/** 把常见别名归一到受支持的语言；未知回退 js。 */
export function normalizeLang(input: string | undefined): InstrumentLang {
  const l = (input ?? "").trim().toLowerCase();
  if (l === "javascript" || l === "node" || l === "jsx") return "js";
  if (l === "typescript" || l === "tsx") return "ts";
  if (l === "py" || l === "python3") return "python";
  if (l === "bash" || l === "sh" || l === "zsh") return "shell";
  if (l === "golang") return "go";
  if (l === "rs") return "rust";
  if (l === "rb") return "ruby";
  return (SUPPORTED_LANGS as string[]).includes(l) ? (l as InstrumentLang) : "js";
}

/** 生成把 {tag,data} POST 到 endpoint 的插桩片段；调用方替换 TAG 并填入要观察的变量。 */
export function instrumentSnippet(lang: InstrumentLang, endpoint: string): string {
  const url = JSON.stringify(endpoint);
  switch (lang) {
    case "js":
    case "ts":
      return [
        "// [debug] remove before shipping",
        `fetch(${url}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag: "TAG", data: { /* vars to inspect */ } }) }).catch(() => {});`,
      ].join("\n");
    case "python":
      return [
        "# [debug] remove before shipping",
        "import urllib.request, json",
        "try:",
        `    urllib.request.urlopen(urllib.request.Request(${url}, data=json.dumps({"tag": "TAG", "data": {}}).encode(), headers={"content-type": "application/json"}), timeout=2)`,
        "except Exception:",
        "    pass",
      ].join("\n");
    case "shell":
      return [
        "# [debug] remove before shipping",
        `curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"tag":"TAG","data":{}}' ${url} >/dev/null 2>&1 || true`,
      ].join("\n");
    case "go":
      return [
        "// [debug] remove before shipping (needs net/http, bytes, encoding/json)",
        `go func() { b, _ := json.Marshal(map[string]any{"tag": "TAG", "data": map[string]any{}}); http.Post(${url}, "application/json", bytes.NewReader(b)) }()`,
      ].join("\n");
    case "rust":
      return [
        "// [debug] remove before shipping (needs ureq + serde_json)",
        `let _ = ureq::post(${url}).send_json(serde_json::json!({"tag": "TAG", "data": {}}));`,
      ].join("\n");
    case "java":
      return [
        "// [debug] remove before shipping",
        "try {",
        `    var __c = (java.net.HttpURLConnection) new java.net.URL(${url}).openConnection();`,
        '    __c.setRequestMethod("POST"); __c.setDoOutput(true); __c.setRequestProperty("content-type", "application/json");',
        '    __c.getOutputStream().write("{\\"tag\\":\\"TAG\\",\\"data\\":{}}".getBytes()); __c.getResponseCode();',
        "} catch (Exception __e) { /* ignore */ }",
      ].join("\n");
    case "ruby":
      return [
        "# [debug] remove before shipping",
        "begin",
        "  require 'net/http'; require 'json'",
        `  Net::HTTP.post(URI(${url}), { tag: "TAG", data: {} }.to_json, "content-type" => "application/json")`,
        "rescue StandardError",
        "end",
      ].join("\n");
    case "php":
      return [
        "// [debug] remove before shipping",
        `@file_get_contents(${url}, false, stream_context_create(["http" => ["method" => "POST", "header" => "content-type: application/json", "content" => json_encode(["tag" => "TAG", "data" => []]), "timeout" => 2]]));`,
      ].join("\n");
    default:
      return instrumentSnippet("js", endpoint);
  }
}

/** 总指南：把插桩取证闭环讲清楚，附 endpoint 与落盘路径。 */
export function instrumentGuide(endpoint: string, logFile: string): string {
  return [
    "调试插桩闭环（先取证、再改代码）：",
    "1. 先列 2-4 个根因假设；针对每个假设在关键路径插入下面的日志片段，把要观察的变量放进 data。",
    `2. 日志经 HTTP 发到本地收集器 ${endpoint}（仅监听 127.0.0.1），同时落盘到 ${logFile}。`,
    '3. 用 tag 区分不同假设/位置（如 "hypo1-entry"、"loop-iter"、"before-return"）。',
    "4. 请用户复现问题；随后调用 debug_log(action:\"read\") 读回运行时数据，判断哪个假设成立、定位根因。",
    "5. 给出针对根因的最小修复（通常 2-3 行）；再次请用户复现确认生效。",
    '6. 确认后移除你加入的全部插桩（搜索 "[debug]" 标记），并调用 debug_log(action:"stop")。',
  ].join("\n");
}
