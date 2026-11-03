import { z } from 'zod';
import { aggregate, command, file, files, text, ref, scope, event, id, reaction, fail } from '@yss123/cage-kernel';
export * from '@yss123/cage-admin/domain';
export const Document = aggregate('Document', {
  fields: { title: text(), createdBy: ref('User'), deptId: ref('Dept'),
    cover: file({ maxBytes: 2 * 1024 ** 2, accept: ['application/pdf'] }).optional(),
    attachments: files({ maxBytes: 2 * 1024 ** 2, maxCount: 3, accept: ['text/plain', 'application/pdf'] }) },
  scope: scope.deptSubtree('deptId'),
});
export const createDocument = command(Document, { name: 'create', from: 'new', to: 'active',
  input: z.object({ title: z.string(), attachments: z.array(z.string().uuid()).optional(), cover: z.string().uuid().optional() }), handler: draft => draft });
export const setFiles = command(Document, { from: 'active', to: null, input: z.object({ id: z.string().uuid(), attachments: z.array(z.string().uuid()) }), handler: (_draft, input) => ({ attachments: input.attachments }) });
export const renameDocument = command(Document, { name: 'rename', from: 'active', to: null, input: z.object({ id: z.string().uuid(), title: z.string() }), handler: (_draft, input) => ({ title: input.title }) });
export const archiveDocument = command(Document, { name: 'archive', from: 'active', to: 'deleted', handler: draft => draft });
export const FilesChanged = event('FilesChanged', { documentId: id() });
export const failFiles = command(Document, { from: 'active', to: null, input: z.object({ id: z.string().uuid(), attachments: z.array(z.string().uuid()) }), emits: [FilesChanged], handler: (_draft, input) => ({ attachments: input.attachments }) });
export const rejectFiles = command(Document, { from: 'active', to: null, invokedBy: 'process', handler: () => fail('REJECT_FILE_CHANGE') });
export const rejectFileChange = reaction(FilesChanged, { command: rejectFiles, tx: 'same', map: e => ({ id: e.documentId }) });
