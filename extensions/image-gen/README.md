# 图像生成

`generate_image` 调用兼容的图像 API，返回项目 `.pi/images/` 下的文件路径。传入 `reference_images` 时走 `/images/edits`，否则走 `/images/generations`。一次可请求 1 至 4 张，默认 1 张。参考图会发送给所选供应商。

## 配置

在桌面设置里为「图像生成」选择供应商和模型。Base URL 和 API Key 从 Pi 模型注册表的供应商配置读取。

| 配置 | 用途 |
| --- | --- |
| `IMAGE_PROVIDER` | 必填；选择已有端点和鉴权的供应商 |
| `IMAGE_MODEL` | 图像模型，未指定时用 `gpt-image-1` |
| `IMAGE_SIZE` | 默认 `1024x1024`；可用工具的 `size` 覆盖 |

已有可用供应商配置时，可从仓库根目录运行 `pi -e ./extensions/image-gen/index.ts` 单独加载。
