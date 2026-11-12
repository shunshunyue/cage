/**
 * 自动化课程的归档系统出站声明，放到 integrations/archive-service.ts 并从 domain 总入口导出。
 * 消费 NoteArchived，仅发送便笺 UUID 和标题；导入不会发 HTTP，真实 IO 由 worker 在主事务提交后执行。
 * hosts 是示例协议地址，secret 只是部署密钥名称；retryableWrite 以对方确实实现幂等去重为前提。
 */
import { connector, op, outbound } from '@yss123/cage-connectors';
import { z } from 'zod';
import { NoteArchived } from '../modules/note/index.js';

/** 约束外部主机、五秒超时及最小请求/回执格式；不在声明内读取或保存真实密钥。 */
export const archiveService = connector('archive-service', {
  hosts: { test: 'archive-sandbox.example.com', prod: 'archive.example.com' },
  secret: 'ARCHIVE_API_TOKEN',
  timeoutMs: 5000,
  operations: {
    save: op({
      effect: 'retryableWrite',
      method: 'POST',
      path: '/api/notes',
      request: z.object({ externalId: z.uuid(), title: z.string() }),
      response: z.object({ receiptId: z.string() }),
    }),
  },
});

/** 同一便笺归档使用稳定业务键；回执由连接器执行记录保存，本例没有额外业务回填字段。 */
export const sendNoteArchive = outbound(NoteArchived, archiveService.operations.save, {
  idempotencyKey: (event) => `note-archive-${event.noteId}`,
  map: (event) => ({ externalId: event.noteId, title: event.title }),
});
