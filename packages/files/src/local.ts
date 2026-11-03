// 私有目录不能挂载为静态资源。逐块写入/校验/合并，内存占用与文件总大小无关。
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cageError } from '@yss123/cage-kernel';
import type { ByteRange, FileStorage, StoredPart } from './storage.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class LocalFileStorage implements FileStorage {
  readonly name: string;
  readonly limits = { minPartBytes: 64 * 1024, maxPartBytes: 64 * 1024 * 1024, maxParts: 10_000 };
  readonly directory: string;
  constructor(directory = process.env.CAGE_FILES_DIR ?? '.cage-files') {
    this.directory = resolve(directory);
    // 配置指向另一目录时不能把旧文件误判成已删除；不向元数据暴露真实路径。
    this.name = `local:v1:${createHash('sha256').update(process.platform === 'win32' ? this.directory.toLowerCase() : this.directory).digest('hex').slice(0, 16)}`;
  }

  private dir(upload: string) {
    if (!uuid.test(upload)) throw cageError('INVALID_INPUT', '非法上传 ID');
    return join(this.directory, upload);
  }
  private path(key: string) {
    if (!/^[0-9a-f-]{36}\/(part|object)-[0-9a-f-]{36}$/.test(key)) throw cageError('INVALID_INPUT', '非法存储键');
    const [id, name] = key.split('/');
    const path = resolve(this.dir(id), name);
    if (!path.startsWith(this.directory + sep)) throw cageError('INVALID_INPUT');
    return path;
  }

  async writePart(upload: string, token: string, source: Readable, o: { bytes: number; sha256: string; signal: AbortSignal }) {
    const key = `${upload}/part-${token}`, destination = this.path(key);
    await mkdir(this.dir(upload), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let bytes = 0;
    const hash = createHash('sha256');
    const verifier = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > o.bytes) { callback(cageError('INVALID_INPUT', '分片超过声明长度')); return; }
      hash.update(chunk); callback(null, chunk);
    } });
    try {
      await pipeline(source, verifier, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: o.signal });
      if (bytes !== o.bytes || hash.digest('hex') !== o.sha256) throw cageError('INVALID_INPUT', '分片长度或 SHA-256 不匹配');
      // fsync 后才确认分片，避免成功响应仅表示写入了用户态缓冲。
      const file = await open(temporary, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      o.signal.throwIfAborted();
      await rename(temporary, destination);
      return key;
    } finally { await rm(temporary, { force: true }); }
  }

  async complete(upload: string, token: string, parts: readonly StoredPart[], o: { bytes: number; signal: AbortSignal }) {
    const key = `${upload}/object-${token}`, destination = this.path(key);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const self = this;
    async function* content() {
      let total = 0;
      for (const part of parts) {
        o.signal.throwIfAborted();
        let bytes = 0;
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(self.path(part.key), { signal: o.signal })) {
          bytes += chunk.length; total += chunk.length;
          if (bytes > part.bytes || total > o.bytes) throw cageError('INVALID_INPUT', '分片内容发生变化');
          hash.update(chunk); yield chunk;
        }
        if (bytes !== part.bytes || hash.digest('hex') !== part.sha256) throw cageError('INVALID_INPUT', '分片内容校验失败');
      }
      if (total !== o.bytes) throw cageError('INVALID_INPUT', '文件长度不匹配');
    }
    try {
      await pipeline(Readable.from(content()), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: o.signal });
      const file = await open(temporary, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      o.signal.throwIfAborted();
      await rename(temporary, destination);
      return key;
    } finally { await rm(temporary, { force: true }); }
  }

  async read(key: string, range?: ByteRange): Promise<Readable> {
    const file = await open(this.path(key), 'r');
    return file.createReadStream(range ? { start: range.start, end: range.end } : {});
  }
  async remove(upload: string) {
    const directory = this.dir(upload);
    // dir() 校验 UUID，绝对路径必须仍在配置目录内，禁止删除根目录。
    if (!directory.startsWith(this.directory + sep)) throw cageError('INVALID_INPUT');
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  async prune(upload: string, keepKey: string) {
    const directory = this.dir(upload);
    if (this.path(keepKey) !== join(directory, keepKey.split('/')[1])) throw cageError('INVALID_INPUT');
    let entries;
    try { entries = await readdir(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    for (const name of entries) if (name !== keepKey.split('/')[1]) await rm(join(directory, name), { force: true });
  }
}
