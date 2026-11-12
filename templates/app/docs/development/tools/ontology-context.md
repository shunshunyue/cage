# 查找业务声明、关系与影响

本体工具回答“这个应用在哪里定义了什么”。它从当前 domain 重新抽取声明，用名称、描述、标识和所属对象匹配，不连接数据库或执行命令。公开框架 API 用[能力诊断](diagnostics.md)查。

## 从关键词找到具体节点

以采购范例为例，在应用根目录执行：

```powershell
pnpm exec cage graph search "取消" --kind command --limit 8
pnpm exec cage graph inspect command:PurchaseOrder.cancel
pnpm exec cage graph path command:PurchaseOrder.cancel command:InventoryLock.release
pnpm exec cage context command:PurchaseOrder.cancel --depth 3 --limit 40
```

search 返回候选，inspect 查看指定节点和直接关联，path 查最短关系链，context 为本次任务组织子图及源码、契约、前端与测试候选。

支持 --format md|json、--out 文件，默认 Markdown；--root 指定应用。输出路径相对应用根目录。空白模板不会把 docs/examples 的采购源码当当前业务。

## 候选怎样使用

完整 key、唯一 ID 或唯一中文全称可形成 exact 定位；关键词模式选取得分接近的少量入口并列出其他候选及理由。先确认入口，再用完整 key 缩小。

中文按名称和相邻词匹配，没有模型或向量服务。未命中时缩短关键词、换标识或分页查看；同义词、否定和复杂业务含义还需阅读源码。候选测试只是定位线索，名字相关不证明覆盖了本次行为。

路径中有 reads、所属对象或文本匹配，不表示一定会执行后续动作。真实自动化要沿 emits、reaction、审批结论或连接器回写确认，map 也可能跳过。

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

context/search/inspect/path 只查询，不更新当前图或命名基线；analyze/gen 可更新 .cage/ontology.json。保留修改前快照到验收结束。

## 图谱准确的前提

对象、字段、状态和动作需要结构化名称；阅读流程需要引用真实声明。写法见[本体建模](../guides/ontology-modeling.md)。图规则验证可识别结构，任意 handler、条件映射和实际授权还需业务用例。

[返回开发手册](../README.md)
