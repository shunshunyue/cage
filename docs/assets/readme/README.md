# README 配图

本目录由仓库根 README 引用，视觉采用米白 `#F6F4EA`、深灰 `#252820` 和少量青柠 `#D5ED86`。图片文字保留在正文或替代文本中，便于检索和辅助阅读。

| 文件 | 内容与维护方式 |
| --- | --- |
| [hero.webp](hero.webp) | 2048 × 768 首屏概念图。使用用户指定的兼容图片服务与 `gpt-image-2` 生成无字插画，再本地排版品牌文字；属于概念表达。 |
| [business-model.svg](business-model.svg) | 手写矢量图，说明同一声明支撑运行、生成和 AI 上下文；文字与关系直接在 SVG 中维护。 |
| [ai-development.svg](ai-development.svg) | 手写矢量图，说明需求到验证的开发过程及反馈；箭头表示推荐工作顺序。 |
| [intelligent-application.webp](intelligent-application.webp) | 1210 × 760 真实应用截图拼图。左侧裁自采购演示的 `assistant-floating-conversation.png`，右侧使用 `approval-history.png`，仅裁剪、排版及压缩。 |

主图提示词见 [hero-prompt.txt](hero-prompt.txt)。品牌字使用本机 Georgia Italic，中文使用 Microsoft YaHei；字体文件不随图片分发。生成接口凭据不保存在素材、提示词或仓库中。

应用拼图使用既有演示记录，展示随页助理和 AI／人工审批界面，不代表当前版本已重新完成真实模型联调。更新时应从实际应用取图，保留审批状态、理由与上下文原文；不可用生图替换产品执行证据。

SVG 采用静态元素与系统字体，不包含脚本、外部资源或 `foreignObject`。修改后检查实际 README 宽度下的文字与箭头，并运行根目录的 `pnpm docs:check`。

[返回项目 README](../../../README.md)
