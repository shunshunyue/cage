/** 文件回归领域：区分字节上传与事务绑定，并用失败的同事务反应验证附件替换完整回滚。 */
import { z } from 'zod';
import { aggregate, command, file, files, text, ref, scope, event, id, reaction, fail } from '@yss123/cage-kernel';
/** 文件所有者、同部门成员与范围外身份都使用真实组织模型。 */
export * from '@yss123/cage-admin/domain';
/** 文档 title 为展示标题，createdBy 为内核创建人，deptId 是部门范围依据；使用默认 active/deleted 状态。 */
export const Document = aggregate('Document', {
  fields: { title: text(), createdBy: ref('User'), deptId: ref('Dept'),
    /** 可为空的单封面上传 ID，仅接收 PDF，单个内容不超过 2 MiB。 */
    cover: file({ maxBytes: 2 * 1024 ** 2, accept: ['application/pdf'] }).optional(),
    /** 私有附件 ID 集合，最多三个、每个 2 MiB，允许纯文本或 PDF；真实字节不存入领域列。 */
    attachments: files({ maxBytes: 2 * 1024 ** 2, maxCount: 3, accept: ['text/plain', 'application/pdf'] }) },
  scope: scope.deptSubtree('deptId'),
});
/** 创建时可同时提交 ready 上传 ID，内核把主对象与附件归属一起原子绑定。 */
export const createDocument = command(Document, { name: 'create', from: 'new', to: 'active',
  input: z.object({ title: z.string(), attachments: z.array(z.string().uuid()).optional(), cover: z.string().uuid().optional() }), handler: draft => draft });
/** 替换完整附件集合，空数组清空；保留状态但仍检查版本并写绑定/解绑审计。 */
export const setFiles = command(Document, { from: 'active', to: null, input: z.object({ id: z.string().uuid(), attachments: z.array(z.string().uuid()) }), handler: (_draft, input) => ({ attachments: input.attachments }) });
/** 仅改标题，用来证明无关更新不会重新要求当前操作者是原上传者或丢失附件。 */
export const renameDocument = command(Document, { name: 'rename', from: 'active', to: null, input: z.object({ id: z.string().uuid(), title: z.string() }), handler: (_draft, input) => ({ title: input.title }) });
/** 归档后新上传的目标状态检查应拒绝继续修改附件。 */
export const archiveDocument = command(Document, { name: 'archive', from: 'active', to: 'deleted', handler: draft => draft });
/** 事件只携带文档 ID，供同事务故障反应定位刚刚修改的对象。 */
export const FilesChanged = event('FilesChanged', { documentId: id() });
/** 有意先提出附件替换并发事件，后续反应必定失败，用来检查绑定状态、主表版本和审计共同回滚。 */
export const failFiles = command(Document, { from: 'active', to: null, input: z.object({ id: z.string().uuid(), attachments: z.array(z.string().uuid()) }), emits: [FilesChanged], handler: (_draft, input) => ({ attachments: input.attachments }) });
/** 确定性失败点，返回业务错误码；不模拟连接失败以免掩盖事务断言。 */
export const rejectFiles = command(Document, { from: 'active', to: null, invokedBy: 'process', handler: () => fail('REJECT_FILE_CHANGE') });
/** 把故障放进同一命令事务，确保失败发生在附件变化之后但提交之前。 */
export const rejectFileChange = reaction(FilesChanged, { command: rejectFiles, tx: 'same', map: e => ({ id: e.documentId }) });
