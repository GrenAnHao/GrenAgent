# 自定义模型按条配置（图片 / 档位 / thinkingFormat / compat）

## 目标

自定义供应商在同一套 API 协议下，每个模型可单独配置：图片输入、思考档位映射、思考协议，以及该协议下全部官方 `compat` 字段。保存时不再按协议整表覆盖 `thinkingLevelMap`。

## UI（已用原型确认）

- 供应商 / 凭据 / 请求头：保持现有单行密度。
- 模型列表：摘要行 + 展开（方案 B）。
- 摘要行：ID、显示名、推理、图片、思考协议标签、上下文、展开/收起、删除。
- 展开后：最大输出、价格、思考协议、七档映射、按 API 分组的全部 compat。
- 模型展开与兼容项：中文标题单独一行；英文原名和解释在下一行。
- Anthropic 专用字段仅在 `api === anthropic-messages` 时写入；设置页可展示但当前 API 不是它时不落盘。

## 落盘

- `reasoning` / `input` / `contextWindow` / `maxTokens` / `cost` / `thinkingLevelMap` 写在模型条目上。
- `thinkingFormat` 与其余兼容开关写在 `compat`。
- 勾选推理且用户未改映射时，仍用协议默认映射作初值；用户改过的映射原样保存。
- 关掉推理则不写 `thinkingLevelMap`。
- `xhigh` / `max` 为 opt-in：映射里非 `null` 才出现在对话档位里。

## 范围外

- 不改供应商级 `compat` 默认（只做模型级）。
- 聊天贴图闸门可随后用 `input` 接上；本变更以设置页与 `models.json` 为准。
