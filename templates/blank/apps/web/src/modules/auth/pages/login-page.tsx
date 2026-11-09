/**
 * 空白应用的登录表单，使用客户端完成认证并由 app 决定成功后的导航。
 * SDK 先认证再读取当前用户和能力，两阶段都成功才通知 app；身份读取失败保留在登录页展示。
 * 账号密码仅用于本次提交，不在本组件持久化或输出日志。
 */
// 认证模块拥有登录表单；登录后的导航由 app 组合层处理。
import { useState, type FormEvent } from 'react';
import { client } from '@app/contracts';
import { errorMessages } from '../../../shared/lib/error-message';
import { Brand } from '../../../shared/ui/brand';

/**
 * 维护本地忙碌与错误状态，使用统一错误文案；成功调用 onLogin 更新应用会话状态。
 * 页面不直接消费未验证的 returnTo，也不会把网络错误当成登录成功。
 */
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * 读取表单中的账号密码并等待 client.login；SDK 完成会话协议与用户能力同步。
   * 返回失败结果时保留页面并提示原因，成功后回跳由 app 路由处理。
   * NOT_FOUND 来自认证后读取当前身份的 GET 结果，单独提示服务配置问题，不误报为账号密码错误。
   */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    // SDK 自动处理会话 Cookie、CSRF 与幂等键；成功后同步当前用户和能力列表。
    const result = await client.login(String(form.get('username')), String(form.get('password')));
    setBusy(false);
    if (result.ok) onLogin();
    else if (result.code === 'NOT_FOUND') {
      // login 的返回类型包含 loadMe 的读取错误；先处理该分支，剩余代码仍由 CommonError 映射穷尽检查。
      setError('无法加载当前登录信息，请检查 API 配置或联系管理员。');
    } else setError(errorMessages[result.code]);
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
