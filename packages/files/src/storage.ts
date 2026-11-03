// 适配器只管理字节。key/token 都由服务端生成，不能接受客户端提供的磁盘路径。
import type { Readable } from 'node:stream';

export interface StoredPart { number: number; key: string; bytes: number; sha256: string }
export interface ByteRange { start: number; end: number }
export interface FileStorage {
  /** 持久标识；重启后必须指向同一存储空间。 */
  readonly name: string;
  readonly limits: { minPartBytes: number; maxPartBytes: number; maxParts: number };
  /** 所有操作都必须可重试；token 隔离过期执行者，不能覆盖其他 token 的产物。 */
  writePart(upload: string, token: string, source: Readable, options: { bytes: number; sha256: string; signal: AbortSignal }): Promise<string>;
  complete(upload: string, token: string, parts: readonly StoredPart[], options: { bytes: number; signal: AbortSignal }): Promise<string>;
  read(key: string, range?: ByteRange): Promise<Readable>;
  /** 删除该上传下的分片及最终内容；没有内容也应成功。 */
  remove(upload: string): Promise<void>;
  /** 完成后的分片回收，不删除最终内容；失败时后续周期重试。 */
  prune(upload: string, keepKey: string): Promise<void>;
}
