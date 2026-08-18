import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { TomatoContext, TomatoSession } from "../api";

const DEFAULT_CONTEXT = "";

interface TomatoLoginPageProps {
  session: TomatoSession | null;
  error: string | null;
  busy: boolean;
  onLogin: (token: string) => Promise<TomatoSession>;
  onSwitchContext: (contextId: string) => Promise<TomatoSession>;
}

function contextValue(context: TomatoContext): string {
  return context.id || context.name;
}

function userLabel(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const value = user as Record<string, unknown>;
  for (const key of ["name", "username", "userName", "nickname", "email"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

export function TomatoLoginPage({
  session,
  error,
  busy,
  onLogin,
  onSwitchContext,
}: TomatoLoginPageProps) {
  const [token, setToken] = useState("");
  const [selectedContext, setSelectedContext] = useState(DEFAULT_CONTEXT);

  useEffect(() => {
    window.localStorage.removeItem("tomato.gitee.pat");
  }, []);
  const [localError, setLocalError] = useState<string | null>(null);
  const contexts = session?.contexts ?? [];
  const defaultContext = useMemo(
    () => contexts.find((context) => contextValue(context) === DEFAULT_CONTEXT || context.name === DEFAULT_CONTEXT),
    [contexts],
  );

  useEffect(() => {
    const current = session?.context;
    const preferred = defaultContext ?? current ?? contexts[0] ?? null;
    if (preferred) setSelectedContext(contextValue(preferred));
  }, [contexts, defaultContext, session?.context]);

  const message = localError ?? error;
  const authenticated = session?.authenticated === true;
  const canChooseContext = authenticated && contexts.length > 0;

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = token.trim();
    if (!value) {
      setLocalError("请输入 Gitee PAT。");
      return;
    }
    setLocalError(null);
    try {
      await onLogin(value);
      setToken("");
    } catch (loginError) {
      setLocalError(loginError instanceof Error ? loginError.message : "登录失败，请检查 PAT。 ");
    }
  }

  async function submitContext() {
    if (!selectedContext) return;
    setLocalError(null);
    try {
      await onSwitchContext(selectedContext);
    } catch (contextError) {
      setLocalError(contextError instanceof Error ? contextError.message : "租户切换失败。");
    }
  }

  return (
    <main className="tomato-auth-shell">
      <section className="tomato-auth-card" aria-labelledby="tomato-auth-title">
        <div className="tomato-auth-brand">
          <span className="tomato-auth-mark" aria-hidden="true">番</span>
          <span>番茄工作台</span>
        </div>
        <div className="tomato-auth-heading">
          <p className="tomato-auth-eyebrow">GITEE TEAM</p>
          <h1 id="tomato-auth-title">连接到番茄</h1>
          <p>{canChooseContext ? "选择要使用的租户后进入工作台。" : "使用 Gitee CLI 登录后管理你的 Team 事项。"}</p>
        </div>

        {message && <div className="tomato-auth-error" role="alert">{message}</div>}

        {!authenticated ? (
          <form className="tomato-auth-form" onSubmit={(event) => void submitLogin(event)}>
            <label>
              <span>服务器地址</span>
              <input value={session?.host ?? ""} readOnly aria-label="服务器地址" />
            </label>
            <label>
              <span>Profile</span>
              <input value={session?.profile ?? "osc"} readOnly aria-label="Gitee profile" />
            </label>
            <label>
              <span>Personal Access Token</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="粘贴你的 PAT"
                autoComplete="current-password"
                autoFocus
                disabled={busy}
              />
            </label>
            <p className="tomato-auth-hint">登录成功后由本机 Gitee CLI 安全保存 Token；网页不会保存 PAT。</p>
            <button className="tomato-auth-primary" type="submit" disabled={busy || !token.trim()}>
              {busy ? "正在登录…" : "使用 Gitee CLI 登录"}
            </button>
          </form>
        ) : canChooseContext ? (
          <div className="tomato-context-picker">
            <div className="tomato-session-summary">
              <span className="tomato-session-dot" aria-hidden="true" />
              <div>
                <strong>{userLabel(session?.user) ?? "Gitee 用户"}</strong>
                <span>{session?.profile} · {session?.host}</span>
              </div>
            </div>
            <label>
              <span>租户</span>
              <select value={selectedContext} onChange={(event) => setSelectedContext(event.target.value)} disabled={busy}>
                {contexts.map((context) => (
                  <option key={contextValue(context)} value={contextValue(context)}>
                    {context.name}{contextValue(context) === DEFAULT_CONTEXT ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="tomato-auth-primary" type="button" onClick={() => void submitContext()} disabled={busy || !selectedContext}>
              {busy ? "正在切换…" : "进入工作台"}
            </button>
          </div>
        ) : (
          <div className="tomato-context-empty">
            <p>已登录，但当前没有可用租户。请先在终端执行 <code>gitee context list</code> 检查配置。</p>
            <button className="tomato-auth-primary" type="button" disabled>暂无可选租户</button>
          </div>
        )}

        <footer className="tomato-auth-footer">
          <span>默认租户</span>
          <strong>{DEFAULT_CONTEXT}</strong>
        </footer>
      </section>
    </main>
  );
}
