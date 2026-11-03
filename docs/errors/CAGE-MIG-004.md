# CAGE-MIG-004

此错误码属于 npm 0.1.0 的旧数据库初始化流程，当前源码已移除该流程，保留本页供历史错误查询。

当前项目首次在根目录 `.env` 填写 `CAGE_ADMIN_DATABASE_URL`，运行 `pnpm exec cage init` 自动准备账号与连接，再执行 `pnpm migrate` 更新表结构。已有集群角色需复用原凭证，不能覆盖其他项目正在使用的密码。
