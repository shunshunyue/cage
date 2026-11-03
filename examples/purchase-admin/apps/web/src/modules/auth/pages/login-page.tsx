// 登录页属于认证模块；表单反馈留在模块内，会话切换由 app 处理。
import { useState, type FormEvent } from 'react';
import { client } from '@app/contracts';
import { errorMessage } from '../../../shared/lib/error-message';

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
