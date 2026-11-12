# 查能力、启用状态与实际执行

先确定要回答哪一个问题，再选择工具。安装包支持、项目声明、磁盘产物、运行进程和业务结果是不同层的证据。

这些查询用于回答具体疑问，无需在每次修改前后依次运行。已有明确文件和调用链时直接阅读源码；需要核对实际授权、执行记录或进程状态时，再取得相应运行证据。

## 公开 API 是否存在

```powershell
pnpm exec cage capabilities "本人" --format json
pnpm exec cage capabilities reactionEach --format json
pnpm exec cage capabilities "AI审批" --format json
```

capabilities 读取已安装包的公开声明，返回包版本、导出名、真实签名、声明文件位置和指南。关键词帮助召回现有符号，例如 AI 审批对应 step 的 AiStepOptions 重载。

它适合核对公开 API 与安装版本；也可直接阅读公开类型。关键词筛选不理解完整业务要求，真实签名也不说明所有组合、默认行为和业务场景都已支持，必要时继续阅读实现与相关测试。

未安装的包标为未检查，未命中不能证明能力不存在。换公开符号或手册用语继续查证；调用参数还要结合指南的前提和实际生成契约。

## 项目是否真正启用

```powershell
pnpm exec cage doctor
```

doctor 汇总声明检查、注册链、路由、生成一致性和构建等证据。检查含 source、reason、next，以及 pass/fail/unknown；离线缺少进程证据时保持 unknown。

退出码 0 为完整通过，1 为发现失败，2 为没有已知失败但证据不完整。JSON 的 complete: false 也不能当完整验收。--format md 或 --out 可保存报告。

这里的完整只针对 doctor 列出的诊断项，不包含业务测试或浏览器验收。authorization 汇总当前租户角色中已配置的能力，不能证明目标用户具备正确范围或某次操作会成功；未配置项也要先核对是否属于本次启用的功能，再按业务规则决定授权。

它默认不连接运行数据库、不迁移、不读取项目密钥，也不替你执行业务测试。

例如离线报告可能包含下面的 JSON 节选。registered 的通过和 api 的未知应分别解释，不能合并为“服务已经运行”：

```json
{
  "ok": true,
  "complete": false,
  "checks": [
    { "id": "registered", "status": "pass", "source": "analyze/check" },
    { "id": "api", "status": "unknown", "source": "not-inspected" }
  ]
}
```

## 进程实际加载了什么

有受控会话后指定运行地址：

```powershell
pnpm exec cage doctor --runtime-url http://127.0.0.1:3000 --cookie-file .cage/diagnostic-cookie.txt
```

运行接口需 Sys.ops.read。Cookie 文件按当前工具要求受限保存，诊断不输出其内容。注册指纹、版本、worker 心跳和消费者记录来自服务，磁盘源码不能代替这些证据。

构建指纹优先检查标准 src→dist 入口及修改时间；非标准布局或缺产物保持未知。函数文本指纹不证明任意闭包、依赖或 JavaScript 行为等价。构建后仍需重启 API/worker。

## 结果卡在异步哪一步

```powershell
pnpm exec cage timeline --request-id 请求标识 --runtime-url http://127.0.0.1:3000 --cookie-file .cage/diagnostic-cookie.txt
```

也可按 --outbox-id，或 --aggregate 与 --aggregate-id 查询。时间线关联实际 outbox、消费者、连接器和审计；它不依据静态箭头推断某次操作完成。

访问还需相关对象 read 和范围，诊断他人另需相应 User.read/范围。没有记录时先检查身份和筛选，再核对真实请求，不能直接认定没有执行。

## 为什么当前主体被拒绝

准备命令输入 JSON，再运行：

```powershell
pnpm exec cage explain Note.archive --input-file .cage/archive-input.json --runtime-url http://127.0.0.1:3000 --cookie-file .cage/diagnostic-cookie.txt
```

受权诊断可用 --user-id 指定用户。工具解释认证、输入、调用身份、能力、范围、状态、版本和硬约束；不执行 handler、不抢更新锁、不写业务审计。新建最终范围和无法检查的依赖会保留未知。

explain 只是观测时刻的说明，实际执行仍重新判断。结果与修复应回到[排错顺序](troubleshooting.md)，最终按[验证参考](../reference/verification.md)证明本次业务完成。

[返回开发手册](../README.md)
