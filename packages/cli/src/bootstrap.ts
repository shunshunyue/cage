/**
 * CLI 的组织初始化与管理员凭据交付边界，由 bootstrap 子命令调用。
 * 先独占创建并限制凭据文件权限，再仅注册组织领域执行 bootstrapOrg，凭据交付参与初始化事务。
 * 不隐式授予业务能力、不打印密码；无论初始化成功与否均关闭临时 kernel，文件交付失败不能被当成成功。
 */
// Explicit organization initialization. Credentials are delivered only through a newly protected file.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { bootstrapOrg } from '@yss123/cage-admin';
import * as organization from '@yss123/cage-admin/domain';
import { createKernel, silentLogger, urlsFromEnv } from '@yss123/cage-kernel';
import { abs, type CageConfig } from './config.js';

/**
 * 独占创建新凭据文件，在任何密码写入前收紧可读写范围。
 * POSIX 请求 0600；Windows 使用实际进程 SID 替换继承 ACL，不信任环境用户名。
 * @param file 已解析的目标路径，父目录必须存在，目标不得已存在。
 * @throws 创建或 ACL 限制失败时抛出 CAGE-INIT-005；已创建空文件可能保留，不能视为交付成功。
 */
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

/**
 * 显式初始化组织并把首次管理员凭据交给受限文件，供 main 的 bootstrap 分支调用。
 * 只注册组织模型；已有用户时不重置账号，返回未创建结果。交付回调失败使初始化事务失败。
 * @param cfg 应用配置，用于解析相对凭据路径。
 * @param credentialsFile 必须指定的新文件路径。
 * @returns created 和凭据文件绝对路径；函数完成后 kernel 已关闭。
 * @throws 凭据准备或初始化失败时返回受控错误，避免 SQL 参数和密码进入日志。
 */
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
