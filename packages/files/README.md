# @yss123/cage-files

私有字节服务：上传会话、可恢复分片、摘要、配额、授权下载与过期清理。字段原语与业务事务绑定属于 kernel，本包不直接保存领域业务结果。

## 使用位置

在服务端安装 pnpm add @yss123/cage-files，Node.js 24+、PostgreSQL 和持久存储由环境提供。标准 cage-http 已装配服务；需要自定义时在 createServer 的 files 选项提供 FileStorage 或 LocalFileStorage。

```ts
import { LocalFileStorage } from '@yss123/cage-files';

/** 交给 HTTP 的 files 配置，目录需持久保存且不能作为公开静态目录。 */
const files = {
  storage: new LocalFileStorage('.cage-files'),
  partBytes: 16 * 1024 * 1024,
  maxFileBytes: 2 * 1024 ** 3,
};
```

应用的 file/files 字段声明 MIME、字节和数量，用户命令 input 接收文件 ID。浏览器使用 cage-client 上传，ready 后再调用领域命令绑定，业务失败不等于正式保存成功。

## 生命周期

上传支持暂停和摘要核对后续传；下载每次检查当前绑定对象授权。已绑定文件通过业务命令移除，临时文件按策略清理。长 IO 使用租约与 token 防迟到回写。

内置本地存储和对象存储适配接口，尚无内置 S3/OSS、签名直传、病毒扫描或共享文件服务。部署需规划持久化、配额及清理，完成上传与业务提交分别显示。

[附件接入](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/files.md) · [事务边界](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/execution.md)
