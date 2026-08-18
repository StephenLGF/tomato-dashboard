import { TomatoCliClient, tomatoCliError } from "./tomato-cli.mjs";

import {
  TOMATO_EXCLUDED_STATUSES,
  isVisibleTomatoStatus,
} from "../shared/tomato-statuses.mjs";

export const NO_FIX_REASON_FIELD = { key: "Dropdown_nofix", name: "不修复理由" };
export const NO_FIX_REASON_UNREPRODUCIBLE = "无法复现";

const TOMATO_PRIORITY_NAMES = new Map([
  ["69e65065-4b34-4109-bca9-0154e548554a", "P0"],
  ["8f7912a5-9176-4a79-a269-2269ac42b5a2", "P1"],
  ["ca8c3e43-3e7b-444d-8940-d0967d944921", "P2"],
  ["1a3e1092-7d70-42ee-ad38-0e8d953c4c23", "P3"],
  ["faae52da-28c8-46fc-96dd-db9cdb28b557", "P4"],
]);

function valueName(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(valueName).find(Boolean) ?? "";
  if (value && typeof value === "object") {
    for (const key of ["name", "label", "nickname", "username", "value", "key"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
  }
  return "";
}

function priorityName(value) {
  const name = valueName(value);
  return TOMATO_PRIORITY_NAMES.get(name) ?? name;
}

function normalizeItem(item) {
  const value = item?.value && typeof item.value === "object"
    ? item.value
    : item?.values && typeof item.values === "object"
      ? item.values
      : item;
  const itemKey = valueName(item?.itemKey ?? item?.key ?? item?.id ?? value?.itemKey ?? value?.key);
  const title = valueName(item?.title ?? item?.name ?? value?.title ?? value?.name ?? value?.["标题"]);
  const status = valueName(item?.status ?? value?.status ?? value?.["状态"]);
  const itemType = valueName(item?.itemType ?? item?.type ?? value?.["类型"] ?? value?.itemType);
  const workspace = valueName(item?.workspace ?? value?.["所属空间"] ?? value?.workspace);
  if (!itemKey || !title || !status || !itemType || !workspace) {
    throw tomatoCliError("Tomato returned an incomplete item", { itemKey: itemKey || null });
  }
  return {
    itemKey,
    title,
    status,
    itemType,
    workspace,
    creator: valueName(item?.creator ?? item?.createdBy ?? value?.["创建人"]),
    priority: priorityName(item?.priority ?? value?.["优先级"] ?? value?.priority),
  };
}

function itemStatus(item) {
  return valueName(
    item?.value?.["状态"]
      ?? item?.value?.status
      ?? item?.value?.["当前状态"]
      ?? item?.["状态"]
      ?? item?.status,
  );
}

export const BUG_READY_FOR_TEST_FIELDS = [
  { fieldKey: "reason2", fieldName: "根因分析" },
  { fieldKey: "Dropdown12", fieldName: "RD引入原因分析" },
  { fieldKey: "Editor33", fieldName: "原因描述" },
  { fieldKey: "CustomVersion2", fieldName: "修复版本" },
  { fieldKey: "Solution", fieldName: "解决方案" },
];

function itemField(item, fieldName) {
  return item?.value?.[fieldName] ?? item?.[fieldName];
}

export function noFixReasonUpdate(targetStatus, noFixReason) {
  if (noFixReason == null || noFixReason === "") return null;
  if (targetStatus !== "不修复" || noFixReason !== NO_FIX_REASON_UNREPRODUCIBLE) {
    throw tomatoCliError("不支持的不修复理由", {
      reason: "INVALID_NO_FIX_REASON",
      targetStatus,
      noFixReason,
    });
  }
  return { [NO_FIX_REASON_FIELD.key]: noFixReason };
}

function hasTomatoValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasTomatoValue);
  if (typeof value === "object") return Object.values(value).some(hasTomatoValue);
  return true;
}

export function preflightBugReadyForTestTransitions(transitions, detail) {
  const missingRequiredFields = BUG_READY_FOR_TEST_FIELDS.filter(
    ({ fieldName }) => !hasTomatoValue(itemField(detail, fieldName)),
  );
  return transitions.map((transition) => {
    if (transition?.targetStatus !== "待测试" || transition?.transition !== "修复完成") {
      return transition;
    }
    if (missingRequiredFields.length === 0) {
      return { ...transition, requirementsKnown: true };
    }
    return {
      ...transition,
      disabled: true,
      disabledReason: `流转前需填写：${missingRequiredFields.map(({ fieldName }) => fieldName).join("、")}`,
      missingRequiredFields,
      requirementsKnown: true,
      requiresAgentPreflight: transition.disabled === false,
    };
  });
}

export function tomatoSearchArguments() {
  return {
    find: {
      "负责人": "currentUser()",
      "所属空间": { $in: ["Gitee-Team", "Gitee-Test"] },
      "类型": { $in: ["Story", "EnablerStory", "Bug", "测试缺陷"] },
      "状态": { $nin: TOMATO_EXCLUDED_STATUSES },
    },
    sort: { "修改时间": -1 },
    size: 50,
    fields: ["priority", "createdBy"],
    resultMode: "compact",
    autoPaginate: true,
    // Team CLI accepts at most 50 per request; the client follows all pages for the board.
    maxItems: 5000,
  };
}

export function tomatoSearchIql() {
  return "负责人 = currentUser() and 所属空间 in ['Gitee-Team', 'Gitee-Test'] and 类型 in ['Story', 'EnablerStory', 'Bug', '测试缺陷']";
}

export class TomatoSyncService {
  constructor({ database, cliExecutable, workspacePath, cli = null, host, profile, defaultContext }) {
    this.database = database;
    this.workspacePath = workspacePath;
    this.cli = cli ?? new TomatoCliClient({
      executable: cliExecutable,
      cwd: workspacePath,
      host,
      profile,
      defaultContext,
    });
    this.syncInFlight = null;
  }

  getSession() {
    return this.cli.getSession();
  }

  login(token) {
    return this.cli.login(token);
  }

  switchContext(contextId) {
    return this.cli.switchContext(contextId);
  }

  sync() {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.#sync().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  async getAvailableTransitions(itemKey) {
    const transitions = await this.cli.listTransitions(itemKey);
    const basicDetail = await this.cli.viewItem(itemKey, {
      fields: ["状态", "类型"],
    });
    const itemType = valueName(itemField(basicDetail, "类型"));
    if (!(itemType === "Bug" || itemType === "缺陷" || itemType === "测试缺陷")) {
      return transitions;
    }
    const detail = await this.cli.viewItem(itemKey, {
      fields: BUG_READY_FOR_TEST_FIELDS.map(({ fieldName }) => fieldName),
    });
    return preflightBugReadyForTestTransitions(transitions, detail);
  }

  async transition(itemKey, targetStatus, { noFixReason } = {}) {
    const reasonUpdate = noFixReasonUpdate(targetStatus, noFixReason);
    const before = await this.cli.viewItem(itemKey, {
      fields: ["状态", ...(reasonUpdate ? [NO_FIX_REASON_FIELD.name] : [])],
    });
    const previousStatus = itemStatus(before);
    if (previousStatus === targetStatus) {
      return {
        itemKey,
        previousStatus,
        currentStatus: previousStatus,
        targetStatus,
        transition: null,
        alreadyInTarget: true,
      };
    }

    let transitions = await this.getAvailableTransitions(itemKey);
    if (reasonUpdate) {
      const matching = transitions.find((candidate) => candidate?.targetStatus === targetStatus);
      if (!matching) {
        throw tomatoCliError(`当前状态无法直接流转到「${targetStatus}」`, {
          reason: "TRANSITION_UNAVAILABLE",
          itemKey,
          currentStatus: previousStatus,
          targetStatus,
          transitions,
        });
      }
      const update = await this.cli.editItem(itemKey, reasonUpdate);
      const rejectedFields = Array.isArray(update?.rejectedFields) ? update.rejectedFields : [];
      if (rejectedFields.some((field) => (
        field?.key === NO_FIX_REASON_FIELD.key || field?.fieldKey === NO_FIX_REASON_FIELD.key
      ))) {
        throw tomatoCliError("番茄拒绝写入不修复理由", {
          reason: "NO_FIX_REASON_REJECTED",
          itemKey,
          rejectedFields,
        });
      }
      const reasonDetail = await this.cli.viewItem(itemKey, {
        fields: ["状态", NO_FIX_REASON_FIELD.name],
      });
      if (valueName(itemField(reasonDetail, NO_FIX_REASON_FIELD.name)) !== noFixReason) {
        throw tomatoCliError("不修复理由写入后回读不一致", {
          reason: "NO_FIX_REASON_VERIFICATION_FAILED",
          itemKey,
        });
      }
      transitions = await this.getAvailableTransitions(itemKey);
    }
    const selected = transitions.find((candidate) => (
      candidate?.targetStatus === targetStatus && candidate?.disabled === false
    ));
    if (!selected) {
      const matching = transitions.find((candidate) => candidate?.targetStatus === targetStatus);
      throw tomatoCliError(
        matching?.disabledReason || `当前状态无法直接流转到「${targetStatus}」`,
        {
          reason: "TRANSITION_UNAVAILABLE",
          itemKey,
          currentStatus: previousStatus,
          targetStatus,
          missingRequiredFields: matching?.missingRequiredFields ?? [],
          transitions,
        },
      );
    }

    const mutation = await this.cli.executeTransition(itemKey, selected.transition);
    const verified = await this.cli.viewItem(itemKey, { fields: ["状态"] });
    const currentStatus = itemStatus(verified);
    if (currentStatus !== targetStatus) {
      throw tomatoCliError("番茄返回流转成功，但回读状态与目标状态不一致", {
        reason: "TRANSITION_VERIFICATION_FAILED",
        itemKey,
        previousStatus,
        currentStatus,
        targetStatus,
        transition: selected.transition,
        mutation,
      });
    }

    await this.sync();
    return {
      itemKey,
      previousStatus,
      currentStatus,
      targetStatus,
      transition: selected.transition,
      alreadyInTarget: false,
      ...(noFixReason ? { noFixReason } : {}),
    };
  }

  close() {}

  async #sync() {
    const search = tomatoSearchArguments();
    const result = await this.cli.searchItems({
      iql: tomatoSearchIql(),
      fields: search.fields,
      size: search.size,
      maxItems: search.maxItems,
    });
    const fetchedItems = Array.isArray(result.items) ? result.items.map(normalizeItem) : [];
    if (result.truncated === true || result.nextPageIndex !== -1) {
      throw tomatoCliError("Tomato sync was incomplete; local cards were not changed", {
        count: result.count,
        fetchedCount: result.fetchedCount,
        nextPageIndex: result.nextPageIndex,
        truncated: result.truncated,
      });
    }
    const items = fetchedItems.filter((item) => isVisibleTomatoStatus(item.status));
    const uniqueKeys = new Set(items.map((item) => item.itemKey));
    if (uniqueKeys.size !== items.length) {
      throw tomatoCliError("Tomato returned duplicate item keys; local cards were not changed");
    }

    return {
      ...this.database.syncTomatoItems(items),
      sourceCount: result.count,
      fetchedCount: result.fetchedCount,
      excludedCount: fetchedItems.length - items.length,
      nextPageIndex: result.nextPageIndex,
      truncated: result.truncated,
    };
  }
}
