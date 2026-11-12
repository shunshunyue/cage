# 查找业务声明、关系与影响

本体工具回答“这个应用在哪里定义了什么”。它从当前 domain 重新抽取声明，用名称、描述、标识和所属对象匹配，不连接数据库或执行命令。公开框架 API 用[能力诊断](diagnostics.md)查。

先阅读本次相关源码、调用方和测试。文件已知或只改局部逻辑时，可直接搜索和跟读代码；需要寻找陌生模块或梳理跨对象声明链时，再用下列工具辅助。它们不是编码前的固定步骤，也不限制继续阅读其他代码。

## 从关键词找到具体节点

以采购范例为例，在应用根目录执行：

```powershell
pnpm exec cage graph search "取消" --kind command --limit 8
pnpm exec cage graph inspect command:PurchaseOrder.cancel
pnpm exec cage graph path command:PurchaseOrder.cancel command:InventoryLock.release
pnpm exec cage context command:PurchaseOrder.cancel --depth 3 --limit 40
```

search 返回候选，inspect 查看指定节点和直接关联，path 在深度内查一条最短声明关系链，context 组织子图及源码、契约、前端与测试候选。path 不枚举全部分支，也不证明一次实际调用会走这条链。

支持 --format md|json、--out 文件，默认 Markdown；--root 指定应用。输出路径相对应用根目录。空白模板不会把 docs/examples 的采购源码当当前业务。

## 候选怎样使用

完整 key、唯一 ID 或唯一中文全称可形成 exact 定位；关键词模式选取得分接近的少量入口并列出其他候选及理由。先确认入口，再用完整 key 缩小。

中文按名称和相邻词匹配，没有模型或向量服务。未命中时缩短关键词、换标识或分页查看；同义词、否定和复杂业务含义还需阅读源码。候选测试只是定位线索，名字相关不证明覆盖了本次行为。

例如“归档以后应该释放什么”未命中，不说明项目没有释放逻辑；先尝试机器名或具体声明，再沿源码跟读：

```powershell
pnpm exec cage graph search archive --kind command
pnpm exec cage context command:Note.archive
```

路径中有 reads、所属对象或文本匹配，不表示一定会执行后续动作。真实自动化要沿 emits、reaction、审批结论或连接器回写确认，map 也可能跳过。

例如 graph path 的 JSON 返回以下节选时，只能说明深度 6 内没找到符合方向的路径。应检查端点、方向、深度和源码，不能据此断言两个业务绝无关系：

```json
{
  "operation": "path",
  "status": "not-found-within-depth",
  "depth": 6,
  "nodes": [],
  "steps": []
}
```

## 在浏览器阅读

```powershell
pnpm exec cage graph
```

打开终端给出的地址。对象与字段视图适合检查引用、基数和字段含义；业务流程按阅读规格展示主线与分支；完整本体用于查技术依赖。

点击节点或连线看中文含义、方向、依据和源码。代码预览来自此次抽取快照，帮助函数仍需继续读文件。更改声明后重新抽取，图谱与上下文才对应新内容。

拖动、缩放和布局只改变显示。图中虚线可能表示异步或对象联系，应阅读该连线的解释；它们不证明一次运行已经成功。

## 修改前保存本体基线

```powershell
pnpm exec cage snapshot save before-change
pnpm exec cage snapshot list
# 修改后：
pnpm exec cage impact --snapshot before-change
```

快照保存版本、时间、指纹和本体，同名不覆盖。还可用 impact --base 真实提交或 --base-file 图文件。没有 Git 基线也可以工作，不需要创建或推送远端。

领域含义变化前保留可比较的基线；已有合适基线时无需再保存一份，示例名称重复使用会报错。impact 按节点哈希、传入的改动文件和已抽取的新旧声明关系推导影响，不分析完整导入或函数调用。辅助函数、闭包值、前端或外部协议变化可能未进入结果，未列出不能说明不受影响。测试列表只是候选，仍需结合源码与业务规则选择验证。

context/search/inspect/path 只查询，不更新当前图或命名基线；analyze/gen 可更新 .cage/ontology.json。保留修改前快照到验收结束。

## 图谱准确的前提

对象、字段、状态和动作需要结构化名称；阅读流程需要引用真实声明。写法见[本体建模](../guides/ontology-modeling.md)。图规则验证可识别结构，任意 handler、条件映射和实际授权还需业务用例。

例如写了 JSDoc 的 title 字段仍需 describe 才进入字段名称；状态名称则写进 labels，不能只在页面上翻译：

<!-- cage:check domain ontology-names -->
```ts
export const titleForGraph = text(120).describe('便笺标题');
export const statesForGraph = states('active', 'archived', {
  terminal: ['archived'], labels: { active: '使用中', archived: '已归档' },
});
```

[返回开发手册](../README.md)
