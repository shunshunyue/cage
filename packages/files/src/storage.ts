// 适配器只管理字节。key/token 都由服务端生成，不能接受客户端提供的磁盘路径。
import type { Readable } from 'node:stream';

/** 已由元数据层确认的分片。number 从 1 开始；bytes 是精确字节数；sha256 为小写十六进制摘要。
 * key 是适配器返回的不透明位置，不向浏览器暴露，也不承担业务授权职责。
 */
export interface StoredPart { number: number; key: string; bytes: number; sha256: string }
/** 下载的闭区间，两端都包含在返回内容中；合法性由 FileService 按文件总长度检查。 */
export interface ByteRange { start: number; end: number }
/** 私有字节存储协议，由 FileService 在数据库事务外调用。
 * 适配器负责内容完整性、流式 IO 和取消；会话所有权、配额、租约与业务绑定由上层处理。
 * 写入返回的 key 必须在进程重启后仍可读取；失败不得让其他执行 token 的内容失效。
 */
export interface FileStorage {
  /** 持久标识；重启后必须指向同一存储空间。 */
  readonly name: string;
  /** 分片最小/最大字节数及每文件最大分片数；服务启动时据此拒绝不兼容配置。 */
  readonly limits: { minPartBytes: number; maxPartBytes: number; maxParts: number };
  /** 所有操作都必须可重试；token 隔离过期执行者，不能覆盖其他 token 的产物。 */
  writePart(upload: string, token: string, source: Readable, options: { bytes: number; sha256: string; signal: AbortSignal }): Promise<string>;
  /** 按调用方给出的顺序合并已确认分片；bytes 是最终总长度，signal 失效后不得报告成功。 */
  complete(upload: string, token: string, parts: readonly StoredPart[], options: { bytes: number; signal: AbortSignal }): Promise<string>;
  /** 返回可读流而非完整 Buffer；调用方负责消费或销毁流，适配器不得公开持久访问 URL。 */
  read(key: string, range?: ByteRange): Promise<Readable>;
  /** 删除该上传下的分片及最终内容；没有内容也应成功。 */
  remove(upload: string): Promise<void>;
  /** 完成后的分片回收，不删除最终内容；失败时后续周期重试。 */
  prune(upload: string, keepKey: string): Promise<void>;
}
