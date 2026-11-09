/**
 * 采购应用认证页面，收集账号密码并调用契约客户端登录。
 * 会话协议和当前能力同步由 SDK 负责；成功后的安全回跳交给 app 路由层。
 */
// 登录页属于认证模块；表单反馈留在模块内，会话切换由 app 处理。
import { useState, type FormEvent } from 'react';
import { client } from '@app/contracts';
import { errorMessage } from '../../../shared/lib/error-message';

/**
 * 维护提交中与失败提示，成功调用 onLogin 通知路由切换。
 * 不在组件内持久化密码，不自行跳转未校验的 returnTo。
 */
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * 阻止浏览器原生表单跳转，读取本次输入并等待 client.login。
   * 成功后由 app 进入已登录路由；错误通过统一映射显示，输入与凭证不写入日志。
   */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const result = await client.login(String(data.get('username')), String(data.get('password')));
    setBusy(false);
    if (result.ok) onLogin();
    else setError(errorMessage(result));
  }
  return (
    <main className="login">
      <div className="login-intro">
        <span className="eyebrow">CAGE / OPERATIONS</span>
        <h1>
          每一笔采购，
          <br />
          有据可循。
        </h1>
        <p>
          从需求到审批，再到入库。
          <br />
          让团队在同一张工作台上协作。
        </p>
        <span className="edition">采购管理 · 示例工作台 / 01</span>
      </div>
      <form onSubmit={submit} className="login-form">
        <span className="eyebrow">WELCOME BACK</span>
        <h2>登录工作台</h2>
        <p className="muted">使用管理员分配的账号继续。</p>
        <label>
          账号
          <input name="username" autoComplete="username" required autoFocus />
        </label>
        <label>
          密码
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? '正在登录…' : '登录 →'}
        </button>
        <small>首次启动的管理员账号显示在 API 终端。</small>
      </form>
    </main>
  );
}
