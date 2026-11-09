/**
 * 管理能力目录的纯内存回归：构造最小聚合与命令注册表，核对中文标签、覆盖优先级和调用身份。
 * 不连接数据库、不授予角色权限；通过断言原目录不变，防止展示层翻译污染真实能力标识。
 */
import { aggregate, buildRegistry, command, states, text } from '@yss123/cage-kernel';
import { expect, it } from 'vitest';
import { adminCatalog } from '../src/catalog.js';

// 展示层不需要数据库；这里验证翻译覆盖不会改变真实能力标识和调用边界。
/**
 * 含两个不同敏感标记的最小单据，用于验证 unmask 能力分别获得正确标签。
 */
const Document = aggregate('Document', {
  description: '业务单据',
  fields: { contact: text().sensitive('phone'), identity: text().sensitive('idCard') },
  states: states('draft', 'approved'),
});
/**
 * 流程专用审批命令，验证中文名称不会丢失 invokedBy 限制。
 */
const approve = command(Document, {
  from: 'draft',
  to: 'approved',
  invokedBy: 'process',
  handler: () => ({}),
});
/**
 * 自定义描述的命令，验证领域说明优先于默认动作词典。
 */
const custom = command(Document, {
  name: 'reconcile',
  description: '核对业务明细',
  from: 'draft',
  to: 'draft',
  handler: () => ({}),
});
const registry = buildRegistry({ Document, approve, custom });

it('从声明和常用动作生成中文，保留流程调用限制及原始权限目录', () => {
  const original = registry.capabilityCatalog();
  const catalog = adminCatalog(registry);
  expect(catalog.aggregates[0].label).toBe('业务单据');
  expect(catalog.capabilities.find((item) => item.capability === 'Document.read')?.label).toBe(
    '查看业务单据',
  );
  expect(catalog.capabilities.find((item) => item.capability === 'Document.export')?.label).toBe(
    '导出业务单据',
  );
  expect(catalog.capabilities.find((item) => item.capability === 'Document.unmask.phone')?.label).toBe(
    '查看手机号明文',
  );
  expect(catalog.capabilities.find((item) => item.capability === 'Document.unmask.idCard')?.label).toBe(
    '查看身份证号明文',
  );
  expect(catalog.capabilities.find((item) => item.capability === 'Document.approve')).toMatchObject({
    label: '审批通过',
    invokedBy: ['process'],
    aggregate: 'Document',
    kind: 'command',
  });
  expect(catalog.capabilities.find((item) => item.capability === 'Document.reconcile')?.label).toBe(
    '核对业务明细',
  );
  expect(registry.capabilityCatalog()).toEqual(original);
});

it('复用图谱中文名，权限专用覆盖优先于命令覆盖', () => {
  const catalog = adminCatalog(registry, {
    'aggregate:Document': '报销单',
    'command:Document.approve': '通过报销审批',
    'capability:Document.approve': '报销审批权限',
    'event:DocumentApproved': '报销审批已通过',
  });
  expect(catalog.aggregates[0].label).toBe('报销单');
  expect(catalog.capabilities.find((item) => item.capability === 'Document.read')?.label).toBe('查看报销单');
  expect(catalog.capabilities.find((item) => item.capability === 'Document.approve')?.label).toBe(
    '报销审批权限',
  );
  expect(catalog.labels['event:DocumentApproved']).toBe('报销审批已通过');
});
