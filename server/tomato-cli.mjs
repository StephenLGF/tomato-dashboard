import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_TOMATO_PROFILE = "osc";
export const DEFAULT_TOMATO_HOST = "https://osc.gitee.work";
export const DEFAULT_TOMATO_CONTEXT = "";

export function tomatoCliError(message, details) {
  const error = new Error(message);
  error.code = "TOMATO_CLI_ERROR";
  error.details = details;
  return error;
}

function unwrap(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return value;
}

function parseJsonOutput(stdout, command) {
  const text = String(stdout ?? "").trim();
  if (!text) throw tomatoCliError(`番茄 CLI 没有返回 JSON：${command}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw tomatoCliError(`番茄 CLI 返回了无效 JSON：${command}`, {
      cause: error.message,
      output: text.slice(0, 2000),
    });
  }
}

function normalizeItems(payload) {
  const value = unwrap(payload, ["items", "data", "result"]);
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  return [];
}

function normalizeTransitions(payload) {
  const value = unwrap(payload, ["transitions", "data", "result"]);
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.transitions)) return value.transitions;
  return [];
}

function normalizeDetail(payload) {
  const value = unwrap(payload, ["item", "data", "result"]);
  return value && typeof value === "object" && !Array.isArray(value) ? value : payload;
}

function normalizeContexts(payload) {
  const value = unwrap(payload, ["contexts", "items", "data", "result"]);
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.contexts)) return value.contexts;
  if (value && Array.isArray(value.items)) return value.items;
  return [];
}

function firstString(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

function normalizeContext(context) {
  if (typeof context === "string") {
    return { id: context, name: context };
  }
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const id = firstString(context, ["id", "contextId", "tenantId", "key", "uuid", "value"]);
  const name = firstString(context, ["name", "displayName", "tenantName", "tenant", "label"]) ?? id;
  if (!id && !name) return null;
  return {
    id: id ?? name,
    name: name ?? id,
    description: firstString(context, ["description", "desc"]),
  };
}

function isAuthFailure(error) {
  const details = error?.details ?? {};
  const output = [details.stderr, details.stdout, details.output, error?.message].filter(Boolean).join(" ").toLowerCase();
  return /未登录|not logged|no profiles configured|auth login|authentication required|unauthenticated|token/.test(output);
}

function isContextFailure(error) {
  const details = error?.details ?? {};
  const output = [details.stderr, details.stdout, details.output, error?.message].filter(Boolean).join(" ").toLowerCase();
  return /未配置企业 context|context required|no context|context switch/.test(output);
}

export class TomatoCliClient {
  constructor({
    executable = process.env.TOMATO_CLI_EXECUTABLE ?? "gitee",
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env,
    profile = DEFAULT_TOMATO_PROFILE,
    host = process.env.TOMATO_HOST ?? DEFAULT_TOMATO_HOST,
    defaultContext = process.env.TOMATO_CONTEXT ?? DEFAULT_TOMATO_CONTEXT,
  } = {}) {
    this.executable = executable;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.profile = profile;
    this.host = host;
    this.defaultContext = defaultContext;
  }

  commandText(args) {
    return [this.executable, ...args].map((argument, index) => (
      args[index - 1] === "--token" ? "<redacted>" : argument
    )).join(" ");
  }

  async runRaw(args) {
    const command = this.commandText(args);
    try {
      return await execFileAsync(this.executable, args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        timeout: this.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      const code = error.code === "ENOENT" ? "TOMATO_CLI_NOT_FOUND" : "TOMATO_CLI_COMMAND_FAILED";
      throw tomatoCliError(
        error.code === "ENOENT"
          ? `找不到番茄 CLI「${this.executable}」，请安装 Gitee CLI 并设置 TOMATO_CLI_EXECUTABLE`
          : `番茄 CLI 命令执行失败：${command}`,
        {
          code,
          exitCode: error.code,
          signal: error.signal,
          stderr: String(error.stderr ?? "").slice(-4000),
          stdout: String(error.stdout ?? "").slice(-4000),
        },
      );
    }
  }

  async run(args) {
    const command = this.commandText(args);
    const result = await this.runRaw(args);
    return parseJsonOutput(result.stdout, command);
  }

  async getSession() {
    let auth;
    try {
      auth = await this.runRaw(["auth", "status", "--profile", this.profile]);
      const authOutput = String(auth.stdout ?? "").trim();
      if (/未登录|not logged|no profiles configured|authentication required|unauthenticated/i.test(authOutput)) {
        return {
          authenticated: false,
          profile: this.profile,
          host: this.host,
          contexts: [],
          context: null,
          user: null,
        };
      }
      if (!/已登录|logged in|authenticated|profile:/i.test(authOutput)) {
        throw tomatoCliError(`番茄 CLI 返回了无法识别的登录状态：gitee auth status --profile ${this.profile}`, {
          output: authOutput.slice(0, 2000),
        });
      }
    } catch (error) {
      if (isAuthFailure(error)) {
        return {
          authenticated: false,
          profile: this.profile,
          host: this.host,
          contexts: [],
          context: null,
          user: null,
        };
      }
      throw error;
    }

    let contexts = [];
    try {
      contexts = normalizeContexts(await this.run([
        "context", "list", "--profile", this.profile, "--output", "json",
      ])).map(normalizeContext).filter(Boolean);
    } catch (error) {
      if (!isContextFailure(error) && !isAuthFailure(error)) throw error;
    }

    let context = null;
    try {
      const current = await this.runRaw(["context", "current", "--profile", this.profile]);
      const currentText = String(current.stdout ?? "").trim();
      const match = currentText.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
      context = match
        ? { name: match[1].trim(), id: match[2].trim() }
        : normalizeContext(currentText);
    } catch (error) {
      if (!isContextFailure(error) && !isAuthFailure(error)) throw error;
    }

    let user = null;
    if (context) {
      try {
        user = await this.run(["team", "user", "current", "--profile", this.profile, "--output", "json"]);
      } catch (error) {
        if (!isContextFailure(error) && !isAuthFailure(error)) throw error;
      }
    }

    return {
      authenticated: true,
      profile: this.profile,
      host: this.host,
      contexts,
      context,
      user,
    };
  }

  async login(token) {
    try {
      await this.runRaw([
        "auth", "login",
        "--host", this.host,
        "--token", token,
      ]);
    } catch (error) {
      throw tomatoCliError("Gitee 登录失败，请检查 PAT 和服务器地址", {
        reason: "LOGIN_FAILED",
        cause: error?.message,
        details: error?.details,
      });
    }

    const session = await this.getSession();
    if (!session.authenticated) {
      throw tomatoCliError("Gitee 登录失败，请检查 PAT 和服务器地址", { reason: "LOGIN_FAILED" });
    }
    const defaultContext = session.contexts.find((candidate) => (
      candidate.id === this.defaultContext || candidate.name === this.defaultContext
    ));
    if (defaultContext && session.context?.id !== defaultContext.id && session.context?.name !== defaultContext.name) {
      await this.switchContext(defaultContext.id);
      return this.getSession();
    }
    return session;
  }

  async switchContext(contextId) {
    await this.runRaw([
      "context", "switch", contextId,
      "--profile", this.profile,
    ]);
    return this.getSession();
  }

  async searchItems({ iql, fields = [], size = 50, maxItems = 500 } = {}) {
    const items = [];
    let page = 1;
    let total = null;
    let nextPageIndex = -1;
    let truncated = false;

    while (items.length < maxItems) {
      const args = [
        "team", "item", "search",
        "--page", String(page),
        "--size", String(Math.min(size, 50)),
        "--iql", iql ?? "",
        "--output", "json",
      ];
      if (fields.length > 0) args.push("--fields", fields.join(","));
      const payload = await this.run(args);
      const pageItems = normalizeItems(payload);
      items.push(...pageItems);
      const pageTotal = Number(payload?.count ?? payload?.total ?? payload?.data?.count);
      if (Number.isFinite(pageTotal)) total = pageTotal;
      const pageSize = Math.min(size, 50);
      const hasMore = payload?.hasNext === true
        || payload?.hasMore === true
        || payload?.nextPageIndex !== undefined && payload.nextPageIndex !== -1
        || (total !== null && items.length < total)
        || (total === null && pageItems.length >= pageSize);
      if (!hasMore || pageItems.length === 0) break;
      page += 1;
      if (items.length >= maxItems) {
        truncated = true;
        nextPageIndex = page;
        break;
      }
    }

    if (total !== null && items.length < total) {
      truncated = true;
      nextPageIndex = page;
    }
    return {
      items: items.slice(0, maxItems),
      count: total ?? items.length,
      fetchedCount: Math.min(items.length, maxItems),
      nextPageIndex,
      truncated,
    };
  }

  async viewItem(itemKey, { fields = [] } = {}) {
    const payload = await this.run(["team", "item", "view", itemKey, "--output", "json"]);
    return normalizeDetail(payload);
  }

  async editItem(itemKey, values) {
    const payload = await this.run([
      "team", "item", "edit", itemKey,
      "--values", JSON.stringify(values),
      "--output", "json",
    ]);
    return unwrap(payload, ["data", "result"]) ?? payload;
  }

  async listTransitions(itemKey) {
    const payload = await this.run(["team", "transition", "list", itemKey, "--output", "json"]);
    return normalizeTransitions(payload);
  }

  async executeTransition(itemKey, transition) {
    const payload = await this.run([
      "team", "transition", "execute", itemKey,
      "--transition", transition,
      "--output", "json",
    ]);
    return unwrap(payload, ["data", "result"]) ?? payload;
  }
}
