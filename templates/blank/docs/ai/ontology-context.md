# 用本体图辅助 AI 开发业务

[返回学习入口](README.md) · [开发步骤](workflow.md)

本页命令在**应用根目录**运行，使用项目安装的 CLI。工具直接分析当前注册的 domain，无需启动 API、worker 或数据库。不要把 Web 截图作为 AI 理解业务的唯一材料：优先取得结构化上下文，再按源码位置阅读实现。

## 在浏览器按业务阅读

运行 `pnpm exec cage graph` 打开业务地图，默认从业务板块进入，再选择完整流程，点击阶段查看规则与实现代码。声明了 `businessProcess` 的板块优先展示完整业务流程；其他板块按真实状态迁移展示对象生命周期。具体操作与查询收在折叠区中。模块目录下的业务对象归入同一板块，未分模块的项目按业务对象组织；查询、任务和外部通知按已声明的读取或调用关系出现在相关板块。系统组织模型默认隐藏，可单独开启。

板块默认使用所属对象的中文名称。可在 `cage.config.json` 的 `graph.labels` 设置 `"module:purchase": "采购管理"` 这样的板块标题；未分模块的对象沿用 `aggregate:对象名`。板块标题属于显示配置，不改变节点身份、本体哈希或业务逻辑。

完整流程以矩形展示业务阶段、菱形展示决定分支、圆角终点展示结束结果。绿色箭头标记业务走向，并注明参与人、自动或等待；棕色箭头标记展开的次要分支；虚线标记涉及的业务对象。取消等次要路径可以展开，审批通过/驳回等主要分支保持可见。主线保持同一轴线，侧面分支使用独立出口和通道，汇合复用已有阶段。长线在源节点附近也显示方向箭头，分支文字注明动作与去向，回路入口注明来源；文字放在线旁，悬停或点选连线可突出显示对应的起点与终点。

主要实现绑定了代码审批路由的阶段默认展开为审批子流程：按声明顺序展示每一步的标题、审批人、任一或全部同意规则；条件用菱形展示，“是”进入该组审批，“否”从侧边跳过整组，再继续后续步骤。所需步骤全部通过才继续业务，任一步骤驳回则结束本轮审批。审批字段和角色使用 `graph.labels` 中的中文名称，点击容器仍可查看原审批及路由源码。未抽取到绑定路由时明确提示缺少步骤；取消审批只作为终止动作展示。这是声明的静态阅读图，不表示某张单据当前走到了哪一步。

普通滚轮以光标为中心缩放，空白处拖动平移；选择模式下可拖动节点，箭头随之更新，抓手模式、空格或中键可从任意位置平移。工具栏支持横向/纵向布局、100% 缩放、适应画布、回到起点、重置节点布局及展开画布（Esc 退出）；触屏支持单指平移与双指缩放。长流程首次按可读字号展示起点，点击“适应”查看全图。点击节点或箭头打开步骤详情与代码面板，查看详情和切换页签保留当前视野与手动布局；这些调整只影响本次页面中的展示，不改写业务声明。

展开具体操作时，触发图只沿事件触发、反应调用、审批结论与外部成功回写展开，异步连线使用虚线。任务的 calls 只表示可调用，反应的 map 仍可能返回 null；读取依赖、同对象归属、状态相接不表示操作必然依次执行。旧项目的生命周期只展示允许的状态迁移，不把人工的下一步当作自动执行。

“实现代码”预览本次抽取保存的完整声明调用，包括 handler、map 或审批路由，提供文件和行号；依赖中的帮助函数仍需按源码阅读。字段、状态和能力点只有聚合位置时，明确显示所属聚合的声明；依赖包没有本地源码位置时不伪造预览。服务只按已注册节点提供快照中的代码，不接受任意文件路径。改代码后点击“重新抽取”，图谱、代码和复制的 AI 上下文才一起更新。

板块、流程、步骤和代码页签保存在 URL 中，支持复制地址、刷新及前进后退。需要查看字段或全部技术关系时，切换“对象与字段”或“完整本体”；步骤详情也可直接进入完整本体及复制 AI 上下文。

## 声明完整业务流程

`businessProcess` 把已有执行声明组织成业务阅读规格，适合把申请、审批、履约、结算串成一条完整主线。它不调度命令、不生成写接口，也不改变数据表或授权。跨模块流程放在 domain 的 `workflows`，单个模块内的流程可放在对应模块，所有引用及流程本身都从 domain 入口导出。

采购范例的完整声明位于 `packages/domain/src/workflows/purchase-process.ts`（空白项目在采购参考源码目录中查找）。以下片段说明主要选项，变量引用该范例已有的聚合、命令和审批：

```ts
export const purchaseOverview = businessProcess('purchase-overview', {
  title: '采购申请到批准', description: '看清申请人提交与审批结论。',
  area: { id: 'purchase', title: '采购管理', description: '采购申请、审批、收货与库存协作。' },
  subject: PurchaseOrder, entry: 'create',
  stages: {
    create: { title: '填写采购申请', description: '保存采购草稿。', actor: '申请人', action: create },
    submit: { title: '提交申请', description: '校验后提交审批。', actor: '申请人', action: submit },
    review: { title: '采购审批', description: '按现有审批规则选人。', kind: 'decision', action: poApproval },
    approved: { title: '批准并锁定库存', description: '审批通过后同事务占用库存。', kind: 'end', action: approve,
      related: [{ object: InventoryLock, label: '锁定采购所需库存', via: acquireLock }] },
    rejected: { title: '审批驳回', description: '本轮采购申请结束。', kind: 'end', action: reject },
  },
  transitions: [
    { from: 'create', to: 'submit', mode: 'manual', label: '申请人提交' },
    { from: 'submit', to: 'review', mode: 'automatic', label: '启动审批' },
    { from: 'review', to: 'approved', mode: 'automatic', label: '审批通过' },
    { from: 'review', to: 'rejected', mode: 'automatic', label: '审批驳回' },
  ],
});
```

- `action` 引用该阶段的主要实现；`details` 可补充命令、反应等实现依据，点击后能分别查看代码。
- `manual` 的目标必须允许用户调用；`automatic` 必须能沿真实触发链到达；`wait` 用于外部通知或定时处理。仅有状态相接不能证明自动执行。
- `related` 的 `object` 引用实际聚合，`via` 引用本阶段实际可触发且涉及该对象的声明。对象关联显示为虚线，不参与流程先后排序。
- `branch: true` 将次要路径收起；每个阶段都需要从入口可达，并能到达至少一个 `kind: 'end'` 的结果。回路直接指向原阶段 ID。
- 同一板块 ID 的名称和说明保持一致；流程按源码声明顺序展示，可把全流程放在专题流程之前。

`cage check` 用 [CAGE-BIZ-001](../errors/CAGE-BIZ-001.md) 和 [CAGE-BIZ-002](../errors/CAGE-BIZ-002.md) 检查声明与实现关系。它不执行 handler、map 或审批，所以仍需业务回归证明运行行为。

阶段直接使用 `title`、`description`、`actor` 的中文文案；操作和字段等继续用 `graph.labels`，审批角色可用 `"role:finance": "财务"`。状态也可在 `states(..., { labels: { draft: '草稿' } })` 中维护中文名；这些名称不更改原有状态标识。

## 开发一项需求的入口

以采购模板为例：

```powershell
# 根据中文需求取得一份可阅读的上下文，默认 Markdown。
pnpm exec cage context "修改采购单取消逻辑"
# 用完整节点身份缩小入口；保存 JSON 供编程工具读取。
pnpm exec cage context command:PurchaseOrder.cancel --format json --out .cage/cancel-context.json
```

报告提供中文名称、稳定 key、候选命中依据、相关业务事实、连接原因与用途、源码位置、契约、前端引用和测试候选、迁移及授权审查提示。没有执行其中的命令或测试，也没有写入数据库。

中文检索按名称、description、标识和所属对象匹配，支持相邻中文词片段；它没有调用语言模型，不保证理解任意自然语言需求。比如“采购单取消”和“取消采购单”可以匹配，但业务同义词、否定句、复杂规则仍需要 AI 阅读源码并结合用户需求确认。

- `selection.mode=exact`：完整 key、唯一 ID 或唯一中文全称定位到一个入口。
- `selection.mode=keyword-candidates`：选取得分接近的最多三个入口生成子图，同时返回其他候选和命中原因。先确认入口符合需求；可复制候选 key 再运行一次。
- 没有命中不表示框架不支持该业务。尝试较短关键词或代码标识。空白模板只注册组织模型，`docs/examples/purchase-admin` 是参考资料，不会被提取为当前项目的采购业务。

## 四个命令怎样配合

```powershell
# 1. 按中文或英文找业务；--kind 可限定节点类型。
pnpm exec cage graph search "取消" --kind command --limit 8
# 2. 精确查看节点属性、所有直接关联及声明位置。
pnpm exec cage graph inspect command:PurchaseOrder.cancel
# 3. 查看两个节点之间的最短关系路径。
pnpm exec cage graph path command:PurchaseOrder.cancel command:InventoryLock.release
# 4. 组织为本次开发所需的上下文。
pnpm exec cage context command:PurchaseOrder.cancel --depth 3 --limit 40
```

这些查询均支持 `--format md|json` 和 `--out <文件>`，默认 Markdown。输出路径相对应用根目录；可通过 `--root <目录>` 指定另一个应用。`cage graph` 不带子命令时仍启动 Web 工作台。

| 查询 | 结果与边界 |
| --- | --- |
| `graph search` | 返回排序候选、score、matches 和源码位置；默认最多 10 项，truncated 表示候选被截断 |
| `graph inspect` | 只接受完整 key、唯一 ID 或唯一中文全称；有歧义或只有模糊匹配时返回候选，请使用完整 key 重试 |
| `graph path` | 默认沿箭头，深度最多 6；用 `--direction both` 探索双向依赖，每一步明确标出逆向遍历 |
| `context` | 默认深度 3、最多 40 个节点；附带的表、字段和状态不继续展开，避免扩大为整张系统图 |

节点身份由类型与 ID 共同构成，例如 `command:PurchaseOrder.cancel`。命令、状态、能力点可以同名，不能只用 ID 合并节点。审批路由的 ID 自带 `route:`，因此完整 key 可能是 `route:route:po-approval`；直接复制工具返回的 key。

路径展示的是**关系链**。读取箭头指向数据来源；双向遍历不改变声明方向。归属虚线不会参与路径搜索，避免经同一所属对象制造两个命令之间的调用关系。没有在深度内找到路径，不代表任意代码之间绝无联系；可提高 `--depth`，或使用双向探索。状态迁移路径会保留 `via` 命令。

## 采购单取消的实际阅读方式

工具可以追踪以下声明：

```text
command:PurchaseOrder.cancel
  → event:OrderCancelled
  → reaction:releaseOnCancel
  → command:InventoryLock.release
```

同时会看到 `OrderCancelled → poApproval` 的 `cancels` 关系，依据是审批绑定的 `cancelOn`。这条关系负责取消审批；释放库存锁由另一条业务反应完成，两者分别检查。

接着阅读报告指向的 `workflows/purchase-inventory.ts`：`releaseOnCancel.map` 仅在事件 `previousStatus === 'approved'` 时返回释放输入，其余返回 null。图能解释订阅、目标和资源标签，不能仅凭存在一条连线就判定每次取消都会释放资源。

源码位置有两个精度：

- `declaration`：定位到顶层声明的文件与行号。
- `aggregate`：字段、状态等只定位到所属聚合声明；继续在该声明内查找具体成员。

`source=null` 表示当前项目静态索引没有位置，常见于来自框架依赖的组织模型；应查依赖的公开 API 和本地指南。报告不会伪造字段的精确行号或复制依赖内部实现。

## 判断证据强度和覆盖范围

每条关系都带 `why`、`purpose` 和 `evidence`：

| evidence.basis | 可以据此判断什么 |
| --- | --- |
| `declared` | 来自 reads、emits、reaction、cancelOn、约束字段等显式声明；仍需阅读执行条件 |
| `inferred` | 从标识推导归属，或由默认事件映射、出站同名字段规则建立关联；核对映射实现 |
| `text-match` | 从 SQL/build 文本匹配字段名；可能命中注释或同名内容，只作为查询依赖线索 |

前端候选按聚合/查询代码名称匹配，项目测试候选按源码标识匹配，均不是完整依赖分析。派生测试按 subject 选择，不意味着这些用例一定能构造有效输入或已经运行成功。

每份报告都带 `extractedAt`、`graphHash`、`freshness`、当前 `findings` 和使用边界。CLI 每次独立进程重新抽取，不读取旧图缓存；Web 复制使用当前图谱快照，明确标为 `displayed-snapshot`，改代码后先点“重新抽取”。`graph.labels` 的显示覆盖独立保存，不改变本体节点 ID 和语义哈希；声明内的 description 仍可能影响语义比较，特别是字段口径说明。

`coverage.truncated` 表示节点上限造成遗漏；`depthBoundary` 指出因深度限制未继续展开的节点。扩大 `--limit` / `--depth` 或改用更精确入口；不能把未出现在子图中的对象当成没有影响。测试、前端候选还分别报告自己的截断情况。

图规则有错误时，只要仍能抽取出图，就输出报告和问题，CLI 返回非零退出码。静态检查阻止 domain 求值时，先按诊断修复，再重新请求上下文。未命中、inspect 歧义、深度内无路径也返回非零；不要因为已经生成文件就当作成功。

## 修改前后形成闭环

```powershell
# 开发前：先取得上下文、阅读实际实现，再保存独立基线。
pnpm exec cage context "采购单取消"
pnpm exec cage snapshot save before-change
# 在源码修改业务声明和实现……
pnpm exec cage check
pnpm gen
pnpm exec cage impact --snapshot before-change
# 按影响和实际风险选择必要测试，审查迁移与管理员授权。
```

`context`、`graph search/inspect/path` 不写入当前 `.cage/ontology.json`；`analyze/gen` 才更新当前图。命名快照写到 `.cage/snapshots`，同名拒绝覆盖，`snapshot list` 显示保存时间、版本与指纹。独立本体图文件和真实 Git 基线仍可使用。基线保留到验收结束，不能把修改后的当前图当作旧图。`context` 用于开发前定位，`impact` 用于修改后比较；二者都不能替代业务验收。详见[诊断与快照](diagnostics.md)。

可直接交给编程工具的要求：

```text
先读 AGENTS.md 和 docs/ai/README.md。
需求：修改……
先运行 cage context 查询需求相关业务，再用 graph inspect/path 消除入口和关系歧义。
按报告的源码位置阅读条件与实现；说明选中的业务入口、影响范围和图的覆盖边界。
修改前另存本体图基线，修改后 check、gen、impact，按风险运行相关验证。
不要只凭名称、连线或测试候选判断需求已完成。
```
