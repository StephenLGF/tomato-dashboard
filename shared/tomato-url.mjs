const TOMATO_ORIGIN = "https://osc.gitee.work";
const DEFAULT_TOMATO_TENANT = "";

export function tomatoItemKeyFromTask(task) {
  if (!task || typeof task !== "object") return null;
  const description = typeof task.description === "string" ? task.description : "";
  const title = typeof task.title === "string" ? task.title : "";
  return description.match(/(?:^|\n)番茄事项：([^\n]+)/u)?.[1]?.trim()
    || title.match(/^\[([^\]]+)\]/u)?.[1]?.trim()
    || null;
}

export function tomatoWorkspaceKey(itemKey) {
  return itemKey
    .replace(/-\d{4}-\d+$/u, "")
    .replace(/-\d+$/u, "")
    .toLowerCase();
}

export function tomatoItemUrl(itemKey, config = {}) {
  const normalizedKey = typeof itemKey === "string" ? itemKey.trim() : "";
  if (!normalizedKey) return null;
  const workspace = tomatoWorkspaceKey(normalizedKey);
  const origin = typeof config.origin === "string" && config.origin.trim()
    ? config.origin.trim()
    : TOMATO_ORIGIN;
  const tenant = typeof config.tenant === "string" && config.tenant.trim()
    ? config.tenant.trim()
    : DEFAULT_TOMATO_TENANT;
  if (!workspace || !tenant) return null;
  const url = new URL(`/_team/${encodeURIComponent(tenant)}/item/${encodeURIComponent(normalizedKey)}`, origin);
  url.searchParams.set("workspace", workspace);
  url.searchParams.set("tenant", tenant);
  url.searchParams.set("hiddenHeader", "true");
  url.searchParams.set("from", "one");
  url.searchParams.set("frameless", "true");
  return url.toString();
}
