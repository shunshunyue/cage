# Cage Logo 与说明配图

本组素材用于 Cage 仓库首页。视觉围绕“业务规则、统一执行、人和 AI 协作”展开，设计日期为 2026-11-08。

![Cage 字标](cage-wordmark.png)

## Logo 与品牌场景

| 素材         | 文件                                                       | 用途                                     |
| ------------ | ---------------------------------------------------------- | ---------------------------------------- |
| 透明 Logo    | [cage-logo.png](cage-logo.png)                             | 1024 × 1024，交织的 C 形框架与青柠连接件 |
| 透明字标     | [cage-wordmark.png](cage-wordmark.png)                     | 1200 × 320，Logo 与 cage 字样组合        |
| 小图标       | [cage-icon.png](cage-icon.png)                             | 128 × 128，文档与仓库缩略图              |
| 首页横幅     | [cage-readme-hero.webp](cage-readme-hero.webp)             | Cage 品牌名称、口号与立体业务世界        |
| 共同业务模型 | [cage-declaration-world.webp](cage-declaration-world.webp) | 用相互连接的区域表现共同规则下的协作     |

## 五张说明图

每张图只回答一个问题，用三到五个主体、大字短句和清楚箭头解释。图中省略底层实现细节，完整技术说明见[架构与执行模型](../../docs/ai/architecture.md)。

| 图                 | 解释的问题                                         | 文件                                        |
| ------------------ | -------------------------------------------------- | ------------------------------------------- |
| 一份规则共同使用   | 为什么业务声明能同时服务运行、接口生成和业务理解？ | [打开说明图](cage-simple-rules.webp)        |
| 框架在系统中的位置 | 用户、AI、Cage、数据库和后台任务如何协作？         | [打开架构图](cage-simple-architecture.webp) |
| 一次业务写入       | 谁在操作、能做什么、当前能否执行、结果如何保存？   | [打开执行图](cage-simple-execution.webp)    |
| 业务助理           | 如何按权限查资料、在修改前确认、按业务规则执行？   | [打开 AI 图](cage-simple-ai.webp)           |
| 开发与交付         | 如何从需求经过规则与页面、生成、验证形成应用？     | [打开开发图](cage-simple-delivery.webp)     |

## 生成记录

Logo、品牌场景及五张说明图均使用用户指定的兼容图片接口和 `gpt-image-2`，通过 imagegen 技能的 CLI/API 工作流生成。请求使用高质量模式。最终图由生成结果导出，说明图保留模型生成的画面、中文和箭头；本地仅做等比缩放与 WebP 压缩。

完整提示词分别保存在 [品牌提示词](prompts.jsonl) 和 [说明图提示词](simple-prompts.jsonl)，均不含密钥或请求头。服务返回的尺寸与请求可能不同，文件以最终导出尺寸为准。

Logo 在本地提取透明背景并生成字标与小图标；首页横幅的中文使用 Microsoft YaHei、字标使用 Georgia Italic 本地排版。字体文件不随素材分发，Logo 是 PNG 位图。七张 README 新配图合计约 1 MB；真实产品截图另位于 `docs/screenshots`。

原图、未选用的探索版与校对预览保存在本机 Git 忽略目录 `.cage/imagegen/readme-brand-20261108`，仓库只保留已选用素材。后续更新先保存新版本，再检查文字、箭头和实际阅读尺寸。

[返回项目 README](../../README.md)
