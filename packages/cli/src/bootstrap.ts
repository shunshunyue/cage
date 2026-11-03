// Explicit organization initialization. Credentials are delivered only through a newly protected file.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { bootstrapOrg } from '@yss123/cage-admin';
import * as organization from '@yss123/cage-admin/domain';
import { createKernel, silentLogger, urlsFromEnv } from '@yss123/cage-kernel';
import { abs, type CageConfig } from './config.js';

export function protectCredentialFile(file: string): void {
  try { closeSync(openSync(file, 'wx', 0o600)); }
  catch { throw new Error('[CAGE-INIT-005] 无法创建新的受限凭据文件；请使用不存在的文件，并检查父目录及其权限'); }
  if (process.platform === 'win32') {
    try {
      // Shell/sandbox accounts may differ from USERNAME. Grant the actual process identity by SID.
      const identity = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      const sid = identity.match(/\bS-\d+(?:-\d+)+\b/)?.[0];
      if (!sid) throw new Error('Current Windows SID unavailable');
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true, stdio: 'pipe' });
    }
    catch { throw new Error('[CAGE-INIT-005] 无法限制凭证文件权限；未生成或写入凭证，请修正文件 ACL 后重试'); }
  }
}

export async function bootstrapOrganization(cfg: CageConfig, credentialsFile: string) {
  if (!credentialsFile) throw new Error('[CAGE-INIT-005] 指定 --credentials-file <新的受限文件>，初始化密码不会写入控制台');
  const file = abs(cfg, credentialsFile);
  protectCredentialFile(file);
  // Only organization declarations are registered, so no business capabilities are granted implicitly.
  const kernel = createKernel({ domain: organization, urls: urlsFromEnv(process.env), logger: silentLogger });
  try {
    const password = randomBytes(24).toString('base64url');
    const result = await bootstrapOrg(kernel, {
      adminPassword: password,
      // Delivery is part of the initialization transaction: a failed write must not strand an administrator.
      deliverCredentials: credentials => writeFileSync(file, JSON.stringify({ ...credentials, note: '仅初始化组织与系统管理能力。业务能力由管理员显式配置；妥善保管并在交付后移除此文件。' }, null, 2) + '\n'),
    });
    if (!result.created) writeFileSync(file, JSON.stringify({ created: false, note: '组织已有用户，未修改账号或密码。' }, null, 2) + '\n');
    return { created: result.created, credentialsFile: file };
  } catch {
    // Do not surface SQL arguments or initialization inputs through a generic error formatter.
    throw new Error('[CAGE-INIT-005] 组织初始化失败；检查迁移与数据库账号，凭证未输出到日志。');
  } finally { await kernel.close(); }
}
