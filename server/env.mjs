import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

function parseValue(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Load the repository-local .env file without overriding variables supplied by
 * the shell, CI, or a process manager. This keeps secrets local while making
 * them available to Codex child processes started by the taskboard.
 */
export function loadProjectEnv(envPath = ENV_PATH, environment = process.env) {
  if (!existsSync(envPath)) return environment;

  const source = readFileSync(envPath, "utf8");
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;

    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || environment[key] !== undefined) continue;
    environment[key] = parseValue(assignment.slice(separator + 1));
  }
  return environment;
}

loadProjectEnv();
