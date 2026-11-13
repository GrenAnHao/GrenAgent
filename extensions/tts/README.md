# 文字转语音

`speak` 合成语音，返回项目 `.pi/audio/` 下的文件路径。默认走 OpenAI 兼容的 `/audio/speech`；根据模型名或 Base URL 识别到 MiMo 时改走 `/chat/completions`。文本和可选的朗读指示会发送给所选供应商。

## 配置

在桌面设置里为「语音 TTS」选择供应商和模型。Base URL 和 API Key 从 Pi 模型注册表的供应商配置读取。

| 配置 | 用途 |
| --- | --- |
| `TTS_PROVIDER` | 必填；选择已有端点和鉴权的供应商 |
| `TTS_MODEL` | 语音模型，未指定时用 `gpt-4o-mini-tts` |
| `TTS_VOICE` | 默认 `alloy`，MiMo 默认 `mimo_default`；工具的 `voice` 可覆盖 |
| `TTS_FORMAT` | 默认 `mp3`；MiMo 支持 `wav` / `pcm16`，默认 `wav` |

已有可用供应商配置时，可从仓库根目录运行 `pi -e ./extensions/tts/index.ts` 单独加载。
