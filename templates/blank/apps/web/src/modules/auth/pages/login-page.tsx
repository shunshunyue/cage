// 认证模块拥有登录表单；登录后的导航由 app 组合层处理。
import { useState, type FormEvent } from 'react';
import { client } from '@app/contracts';
import { errorMessages } from '../../../shared/lib/error-message';
import { Brand } from '../../../shared/ui/brand';

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    // SDK 自动处理会话 Cookie、CSRF 与幂等键；成功后同步当前用户和能力列表。
    const result = await client.login(String(form.get('username')), String(form.get('password')));
    setBusy(false);
    if (result.ok) onLogin();
    else setError(errorMessages[result.code]);
  }

  return (
    <main className="login-layout">
      <section className="login-story">
        <Brand />
        <div className="story-copy">
          <p className="eyebrow">为你的业务，留出空间</p>
          <h1>
            从这里，
            <br />
            开始自己的业务<span>。</span>
          </h1>
          <p className="story-description">
            基础已经就绪。让每一个流程，
            <br />
            按你的业务方式运转。
          </p>
        </div>
        <div className="story-foot">
          <span className="status-dot" />
          业务工作台<span className="edition">CAGE / WORKSPACE</span>
        </div>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-form-wrap">
          <span className="section-number">01 / 欢迎回来</span>
          <h2 id="login-title">登录工作台</h2>
          <p className="muted">使用管理员为你配置的账号继续。</p>
          <form onSubmit={submit} className="login-form">
            <label htmlFor="username">账号</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              placeholder="请输入账号"
              required
              autoFocus
              disabled={busy}
            />
            <label htmlFor="password">密码</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="请输入密码"
              required
              disabled={busy}
            />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? '正在登录…' : '进入工作台'}
              <span aria-hidden="true">↗</span>
            </button>
          </form>
          <p className="login-note">首次使用的管理员账号，请查看 API 启动终端。</p>
        </div>
        <span className="panel-foot">一个属于你的业务起点</span>
      </section>
    </main>
  );
}
