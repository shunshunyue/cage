# @yss123/cage-kernel

笼子内核：声明原语、写入流水线、范围组合子、读侧、worker 运行时

Cage 是通过 TypeScript 声明业务、由框架统一执行权限和数据规则的中后台框架。此包是框架的一部分。

## 使用

```powershell
pnpm add @yss123/cage-kernel
```

首次使用建议通过脚手架创建完整项目，所需依赖由模板统一配置。需要 Node.js 24 或更新版本。

从 `0.2.0` 起，支持把 `ref()`、`hasMany()`、`manyToMany()` 统一声明在聚合 `fields` 中。多对多中间表由框架生成，关联通过命令修改、通过安全接口分页读取。详见[对象关系指南](https://github.com/shunshunyue/cage/blob/main/docs/ai/relations.md)；脚手架产物也自带这份指南。

- [完整使用说明](https://github.com/shunshunyue/cage/blob/main/docs/使用说明.md)
- [框架源码与范例](https://github.com/shunshunyue/cage)
- [问题反馈](https://github.com/shunshunyue/cage/issues)

许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
