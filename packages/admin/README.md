# @yss123/cage-admin

提供用户、部门、角色、授权、防提权约束及 /admin/ 系统管理。它管理组织基础，业务状态仍属于应用领域。

## 注册与初始化

安装 pnpm add @yss123/cage-admin。在 domain 根入口保留：

```ts
/** 组织模型与业务共同注册，导入不创建账号。 */
export * from '@yss123/cage-admin/domain';
```

标准 cage-http 装配管理页，API/worker 使用相同 domain。先 init、构建/生成、审查并 migrate，再显式运行 cage bootstrap --credentials-file .cage/admin-credentials.json。

凭据只交付新受限文件，交付后移除。首次超级管理员获得受控 * 标记，展开当前及以后新增能力和本租户全部范围；普通角色显式授权。已有组织不重置密码或自动升级角色。

## 授权与能力

角色能力、聚合范围、调用身份和业务约束分别生效。被选为审批人不会自动获得权限，前端 can 仅控制显示。普通管理员不能创建超级管理员标记或间接接管该角色。

bootstrapOrg/grantAll 等服务端维护 API 需要受信任调用者，不是普通业务自助授权接口。浏览器使用客户端，不能导入组织运行时。尚无完整的移动部门和菜单配置能力。

[权限与范围](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/authorization.md) · [启动与凭据](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/start.md)
