# 能力发现与状态诊断

业务开发方法见[框架开发 Skill](../skills/cage-development/SKILL.md)。按任务目录或本地文本搜索定位手册，再用 `capabilities` 核对当前安装版本的公开类型、`context` 定位当前应用的声明。三者分别提供教学说明、API 签名和应用证据，不需要独立知识服务或向量索引。

```powershell
pnpm exec cage capabilities 本人 --format json
pnpm exec cage capabilities reactionEach --format json
pnpm exec cage capabilities "AI审批" --format json
pnpm exec cage capabilities "页面上下文" --format json
pnpm exec cage capabilities "性格" --format json
pnpm exec cage context "设备归还" --format json
pnpm exec cage doctor --format json
```

公开能力报告包含包版本、真实签名、公开导出名、声明位置与本地学习指南。未安装的包标为未检查；未命中关键词不能证明能力不存在。完整例子见 [原语](../reference/primitives.md) 和 [任务配方](../guides/recipes.md)。

原生智能化可用“AI审批”“业务助理”“随页助理”“模型管理”“性格”“Responses”“上下文预算”等关键词检索，结果指向[智能化指南](../guides/intelligence.md)。例如 AI 审批返回现有 `step` 的重载及 `AiStepOptions`，不是另造 `aiStep` 原语。公开能力可被检索，不代表本应用已经导出 `ai()`、执行迁移、配置模型或授予角色权限；接着核对项目启用状态，最后进行实际功能验证。

`doctor` 复用 `check`、`gen --check`，输出统一的 `schemaVersion / observedAt / checks / findings / registration / routes`。每个检查包含 `status / source / reason / next`。`pass` 表示相应证据通过，`fail` 表示已发现问题，`unknown` 表示未检查；`complete: false` 不能作为完整验收通过。注册报告列出声明位置、domain 入口、注册节点和对应路由，集合反应还包含上限、排序键、顺序和事务。

诊断命令默认输出 JSON，`--format md` 输出 Markdown；`--out` 可保存报告。doctor 退出码为 0 表示完整通过，1 表示发现失败，2 表示尚有未知证据。离线使用通常返回 2，仍会交付已完成检查的结果。

默认不连接数据库、不读取项目密钥、不执行迁移或测试。需要实际进程证据时显式指定运行地址和受控会话 Cookie 文件：

```powershell
pnpm exec cage doctor --runtime-url http://127.0.0.1:3000 --cookie-file .cage/diagnostic-cookie.txt
```

此模式只调用受 `Sys.ops.read` 保护的诊断接口。证据缺失、服务未运行、没有权限或没有 worker 心跳时标记 `unknown`；接口显示已加载版本和注册指纹，不能仅凭磁盘源码推断进程已经更新。能力已配置给某个角色也不代表任意用户具备范围、额度或调用身份。完成修改后仍需运行 `verify` 和实际业务验收。

运行指纹优先使用项目标准 `src→dist` 的实际编译入口，并逐文件检查源码与对应产物的修改时间。缺少构建或使用非标准输出布局时标记未知；编译后还需要重启 API 和 worker。源码经不同转换器执行时的函数文本可能不同，因此不把源码指纹直接当作生产产物指纹。

指纹包含声明结构与函数文本，不能证明任意闭包、外部依赖或 JavaScript 行为等价。首阶段按同版本 API/worker 升级；既有在途出站应先排空并核对远端幂等键，本轮远端键带租户前缀，不能把旧请求直接当作使用新键的同一次重试。

## 解释授权与追踪异步执行

```powershell
pnpm exec cage timeline --request-id 请求关联标识 --runtime-url http://127.0.0.1:3000 --cookie-file .cage/diagnostic-cookie.txt
pnpm exec cage timeline --aggregate RentalApplication --aggregate-id 对象UUID --runtime-url http://127.0.0.1:3000 --cookie-file .cage/diagnostic-cookie.txt
pnpm exec cage explain RentalApplication.allocate --input-file .cage/allocate-input.json --runtime-url http://127.0.0.1:3000 --cookie-file .cage/diagnostic-cookie.txt
```

时间线也可通过 `--outbox-id` 查询。`explain` 的 JSON 文件只包含目标命令输入，`--user-id` 可诊断指定用户；接口不会执行该命令。CLI 自动取得 CSRF 令牌并合并 Cookie 后提交解释请求，不在输出中显示令牌或 Cookie。

三个运行诊断入口都要求 `Sys.ops.read`。读取业务时间线还需要对应对象的 read 能力和数据范围；诊断他人还要求 User.read 及相应范围。服务器继续进行这些校验，CLI 不会替调用人扩大范围。时间线只展示实际 outbox、消费者处理、连接器和审计记录，不用静态关系推断某次任务已执行。没有记录时应继续核对身份、筛选范围和业务写入结果。

连接器结果为 `unknown` 时，普通死信重放仍会拒绝外呼。当前没有通用确认回执或解除未知状态入口，必须先核对远端，再按具体连接器制定受控恢复或业务补偿；时间线不能替代远端事实。

## 保管本体基线

```powershell
pnpm exec cage snapshot save before-rental-change
pnpm exec cage snapshot list
# 修改声明之后
pnpm exec cage impact --snapshot before-rental-change --format json
```

命名快照保存时间、框架版本、图指纹与本体图，写入 `.cage/snapshots`；同名不覆盖。`context` 和图谱查询不再写入当前图文件，也不会修改已保存基线。已有 `impact --base <Git提交>`、`--base-file <本体图或快照>` 继续可用。

## 显式初始化组织

`cage init` 准备已有数据库中的账号；审查并执行迁移后，用独立命令初始化组织：

```powershell
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
```

目标必须是新文件，父目录需存在。CLI 在写入密码前限制文件权限；Windows 使用实际执行进程 SID 设置独占 ACL，适用于服务/沙箱账号，不信任环境中的用户名；其他系统使用 `0600`。凭证在组织事务提交前写入，交付失败使组织和账号一起回滚；文件本身不能替代命令成功结果。凭证不输出到普通控制台或服务日志。组织已有用户时不重置密码。此命令仅注册组织模型，不自动赋予业务权限；业务能力需管理员显式配置。凭证文件必须保密并在交付后移除。

## 前端校验和 SDK

生成契约保留可表达的 strict 对象、数值倍数与默认值。自定义 `refine/superRefine`、transform 等可执行规则不能完整复制到客户端；生成报告通过 `CAGE-GEN-003` 指出字段路径，OpenAPI 通过 `x-cage-server-validation` 标记。服务端校验始终决定写入是否接受。

SDK 的 `get/post` 返回 `CageResult`；断网、读取响应体失败、主动取消、超时分别返回可预测的结果。请求选项支持 `signal/timeoutMs`。网络失败不自动重发写请求；仅 CSRF 明确拒绝时，刷新令牌并保留同一幂等键重试一次。

主动取消和超时只取消客户端等待，不保证服务端尚未提交。需要重试写请求时保留同一业务输入及 `idempotencyKey`，先核对服务端结果；生成的命令方法也接受 `RequestOptions`。不要因为浏览器取消就把已发生的业务操作显示为已撤销。

`useCageCommand` 失败抛 `CageCommandError`，其 `result` 保存错误码、领域错误和请求标识；成功返回业务数据，mutation 的 `isSuccess` 表示业务成功。独立 `CageClient` 保存独立身份和能力；默认导出的 `loadMe/currentUser/can` 可指定实例。应用订阅 `client.subscribe` 的退出、401、账号切换事件，取消用户相关请求并清理自己的查询缓存；旧响应不会覆盖新的会话身份。

派生测试可通过 `DerivedOptions.seed/fixtures` 提供固定种子与合法业务夹具。`CAGE-TEST-002` 区分 fixture 与 execution 阶段，保留初始数据、准备序列、前置不变量与失败前缀；诊断中的敏感字段会遮盖。最短已观察失败前缀用于重放，不等于对任意业务程序求得全局最小反例。
