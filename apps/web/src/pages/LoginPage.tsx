import { useState, type FormEvent } from 'react';
import { useAppState } from '../hooks/useAppState';
import { ErrorBanner } from '../components/Common';
import { AppearanceMenu } from '../components/AppearanceMenu';
import { Icon } from '../components/Icon';
import { ApiError } from '../lib/errors';

export function LoginPage() {
  const { signIn, initialError, refreshAuth } = useAppState();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null); setBusy(true);
    try { await signIn(username, password); }
    catch (reason) { setError(reason); setBusy(false); }
  };
  return <main className="login-page"><div className="standalone-appearance"><AppearanceMenu /></div><div className="login-brand"><span className="brand-mark">NF</span><span>多 NF 工作台</span></div>
    <section className="login-card"><div className="eyebrow">统一入口 · 独立身份</div><h1>登录工作台</h1><p>查看已授权的会话摘要，或进入你的 NF 实例。</p>
      <ErrorBanner error={initialError} retry={refreshAuth} />{error instanceof ApiError && error.code === 'UNAUTHENTICATED' ? <div className="notice notice-error" role="alert">登录未通过，请核对账号和密码。<small>错误码：UNAUTHENTICATED</small></div> : <ErrorBanner error={error} />}
      <form onSubmit={submit} className="form-stack"><label>账号<input value={username} onChange={event => setUsername(event.target.value)} required maxLength={64} autoComplete="username" autoCapitalize="none" spellCheck={false} /></label>
        <label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={512} autoComplete="current-password" /></label>
        <button className="button primary login-submit" disabled={busy}>{busy ? '正在登录…' : '登录'}<Icon name="arrow" /></button>
      </form><p className="login-note">工作台账号与各 NF 账号相互独立。原站登录状态只保存在各自站点。</p>
    </section><p className="login-footer">仅汇集明确授权的摘要，不读取聊天正文。</p></main>;
}
