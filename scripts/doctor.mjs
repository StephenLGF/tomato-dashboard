import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import "../server/env.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE = [22, 5, 0];
const packageJson = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");

const results = [];

function addResult(kind, name, detail, extra = {}) {
  results.push({ kind, name, detail, ...extra });
}

function formatVersion(version) {
  return version.replace(/^v/u, "").trim().split(/\s+/u)[0] || "unknown";
}

function parseVersion(value) {
  const match = String(value).match(/(\d+)\.(\d+)(?:\.(\d+))?/u);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function run(command, commandArgs, { timeout = 8_000 } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) return { ok: false, error: result.error, stdout: "", stderr: "" };
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function checkExecutable(label, executable, versionArgs, { required, detail } = {}) {
  const result = run(executable, versionArgs);
  if (!result.ok) {
    addResult(required ? "fail" : "warn", label, detail ?? `未找到或无法执行 ${executable}`, {
      required,
      executable,
    });
    return false;
  }
  const version = formatVersion(result.stdout || result.stderr);
  addResult("ok", label, `${executable} ${version}`, { required, executable, version });
  return true;
}

function checkFile(label, filePath, { required = true } = {}) {
  if (!existsSync(filePath)) {
    addResult(required ? "fail" : "warn", label, `缺少 ${path.relative(PROJECT_ROOT, filePath) || filePath}`, {
      required,
      path: filePath,
    });
    return false;
  }
  addResult("ok", label, path.relative(PROJECT_ROOT, filePath) || filePath, {
    required,
    path: filePath,
  });
  return true;
}

function parseMcpList(stdout) {
  const payload = JSON.parse(String(stdout).trim());
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.servers)
      ? payload.servers
      : Array.isArray(payload?.mcpServers)
        ? payload.mcpServers
        : [];
  return entries
    .filter((entry) => entry && typeof entry === "object" && typeof entry.name === "string")
    .map((entry) => ({ name: entry.name.trim(), enabled: entry.enabled !== false }))
    .filter((entry) => entry.name);
}

function checkMcpServers(codexExecutable) {
  const result = run(codexExecutable, ["mcp", "list", "--json"], { timeout: 12_000 });
  if (!result.ok) {
    addResult("warn", "Codex MCP 列表", "无法读取用户侧 MCP 配置；这不会影响浏览器模式", {
      required: false,
    });
    return;
  }

  let servers;
  try {
    servers = parseMcpList(result.stdout);
  } catch {
    addResult("warn", "Codex MCP 列表", "Codex 返回的 MCP 列表不是有效 JSON", { required: false });
    return;
  }

  const enabled = new Set(servers.filter((server) => server.enabled).map((server) => server.name));
  const disabled = new Set(servers.filter((server) => !server.enabled).map((server) => server.name));
  addResult("ok", "Codex MCP 配置", `${enabled.size} 个启用，${disabled.size} 个禁用`, {
    required: false,
    servers: [...enabled].sort(),
  });

  for (const [name, description] of [
    ["tomato", "番茄详情、评论和其他远端读取能力；同步链路不强制要求"],
    ["code", "代码搜索或代码操作能力；看板运行不强制要求"],
  ]) {
    if (enabled.has(name)) {
      addResult("ok", `MCP ${name}`, "已启用", { required: false, configured: true });
    } else if (disabled.has(name)) {
      addResult("warn", `MCP ${name}`, `已配置但未启用：${description}`, {
        required: false,
        configured: true,
        enabled: false,
      });
    } else {
      addResult("warn", `MCP ${name}`, `未配置（可选）：${description}`, {
        required: false,
        configured: false,
      });
    }
  }
}

function checkTomatoAuth(tomatoExecutable) {
  const result = run(tomatoExecutable, ["auth", "status", "--output", "json"], { timeout: 12_000 });
  if (!result.ok) {
    addResult("warn", "番茄 CLI 登录状态", "无法读取认证状态；仅在同步番茄事项时需要", {
      required: false,
      executable: tomatoExecutable,
    });
    return;
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (/未登录|not\s+logged\s+in|not\s+authenticated|unauthenticated/iu.test(output)) {
    addResult("warn", "番茄 CLI 登录状态", "未登录；同步番茄事项前请先完成 gitee auth login", {
      required: false,
      executable: tomatoExecutable,
    });
    return;
  }

  addResult("ok", "番茄 CLI 登录状态", "已返回认证状态（不会显示凭证）", {
    required: false,
    executable: tomatoExecutable,
  });
}

function checkDependencies() {
  const dependencyGroups = [packageJson.dependencies ?? {}, packageJson.devDependencies ?? {}];
  const missing = [];
  for (const group of dependencyGroups) {
    for (const name of Object.keys(group)) {
      if (!existsSync(path.join(PROJECT_ROOT, "node_modules", ...name.split("/"), "package.json"))) {
        missing.push(name);
      }
    }
  }
  if (missing.length > 0) {
    addResult("fail", "npm 依赖", `缺少 ${missing.join(", ")}；请先运行 npm install`, {
      required: true,
      missing,
    });
  } else {
    addResult("ok", "npm 依赖", "package.json 中声明的依赖均已安装", { required: true });
  }
}

function main() {
  const nodeVersion = parseVersion(process.version);
  if (!nodeVersion || compareVersion(nodeVersion, MIN_NODE) < 0) {
    addResult("fail", "Node.js", `需要 >= ${MIN_NODE.join(".")}，当前为 ${process.version}`, { required: true });
  } else {
    addResult("ok", "Node.js", `${process.version}（满足 >= ${MIN_NODE.join(".")}）`, { required: true });
  }

  checkExecutable("npm", "npm", ["--version"], { required: true });
  checkDependencies();

  for (const [label, relativePath] of [
    ["服务入口", "server/index.mjs"],
    ["前端入口", "web/index.html"],
    ["环境模板", ".env.example"],
    ["项目 Skill 文件", "skills/tomato-workboard/SKILL.md"],
    ["插件清单", "plugins/tomato-workboard/.codex-plugin/plugin.json"],
  ]) {
    checkFile(label, path.join(PROJECT_ROOT, relativePath));
  }

  const codexExecutable = process.env.CODEX_EXECUTABLE || "codex";
  const hasCodex = checkExecutable("Codex CLI", codexExecutable, ["--version"], {
    required: false,
    detail: `未找到 ${codexExecutable}；仅在使用 Codex 集成模式时需要`,
  });
  if (hasCodex) checkMcpServers(codexExecutable);
  else addResult("warn", "Codex MCP 配置", "跳过检查：Codex CLI 不可用", { required: false });

  const tomatoExecutable = process.env.TOMATO_CLI_EXECUTABLE || "gitee";
  const hasTomatoCli = checkExecutable("番茄 CLI", tomatoExecutable, ["version"], {
    required: false,
    detail: `未找到 ${tomatoExecutable}；仅在同步番茄事项时需要`,
  });
  if (hasTomatoCli) checkTomatoAuth(tomatoExecutable);

  const failures = results.filter((result) => result.kind === "fail");
  const warnings = results.filter((result) => result.kind === "warn");
  const summary = {
    ok: failures.length === 0,
    failures: failures.length,
    warnings: warnings.length,
    results,
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = failures.length > 0 ? 1 : 0;
    return;
  }

  console.log("Codex 工作台 doctor");
  console.log("只读检查：不会修改项目文件、Codex 配置或 token。\n");
  for (const result of results) {
    const marker = result.kind === "ok" ? "✓" : result.kind === "warn" ? "!" : "✗";
    console.log(`[${marker}] ${result.name}: ${result.detail}`);
  }
  console.log(`\n结果：${failures.length} 个必需项失败，${warnings.length} 个可选项提醒。`);
  if (warnings.length > 0) {
    console.log("可选项提醒不会阻止浏览器模式启动；请按实际使用场景补齐 Codex 或 MCP。");
  }
  process.exitCode = failures.length > 0 ? 1 : 0;
}

main();
