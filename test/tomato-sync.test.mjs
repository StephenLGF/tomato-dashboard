import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TOMATO_EXCLUDED_STATUSES,
  isVisibleTomatoStatus,
} from "../shared/tomato-statuses.mjs";
import {
  NO_FIX_REASON_FIELD,
  NO_FIX_REASON_UNREPRODUCIBLE,
  noFixReasonUpdate,
  preflightBugReadyForTestTransitions,
  tomatoSearchArguments,
} from "../server/tomato-sync.mjs";

test("unable-to-reproduce uses the discovered no-fix field and exact option", () => {
  assert.deepEqual(noFixReasonUpdate("不修复", "无法复现"), {
    [NO_FIX_REASON_FIELD.key]: NO_FIX_REASON_UNREPRODUCIBLE,
  });
  assert.equal(noFixReasonUpdate("不修复", undefined), null);
  assert.throws(() => noFixReasonUpdate("待测试", "无法复现"), /不支持的不修复理由/);
  assert.throws(() => noFixReasonUpdate("不修复", "其他"), /不支持的不修复理由/);
});

test("Tomato sync excludes terminal statuses in the CLI query and display guard", () => {
  const expected = ["测试通过", "测试完成", "不修复", "已取消"];
  assert.deepEqual(TOMATO_EXCLUDED_STATUSES, expected);
  assert.deepEqual(tomatoSearchArguments().find["状态"].$nin, expected);
  for (const status of expected) assert.equal(isVisibleTomatoStatus(status), false);
  assert.equal(isVisibleTomatoStatus("待测试"), true);
  assert.equal(isVisibleTomatoStatus("新建"), true);
});

test("Tomato sync includes EnablerStory cards", () => {
  assert.deepEqual(
    tomatoSearchArguments().find["类型"].$in,
    ["Story", "EnablerStory", "Bug", "测试缺陷"],
  );
});

test("Bug ready-for-test transition is disabled until required fields are present", () => {
  const transitions = [{
    transition: "修复完成",
    targetStatus: "待测试",
    disabled: false,
    missingRequiredFields: [],
    requirementsKnown: false,
  }];
  const [blocked] = preflightBugReadyForTestTransitions(transitions, {
    value: { 类型: "测试缺陷", 根因分析: "代码问题" },
  });
  assert.equal(blocked.disabled, true);
  assert.equal(blocked.requirementsKnown, true);
  assert.deepEqual(
    blocked.missingRequiredFields.map(({ fieldName }) => fieldName),
    ["RD引入原因分析", "原因描述", "修复版本", "解决方案"],
  );

  const [available] = preflightBugReadyForTestTransitions(transitions, {
    value: {
      类型: "Bug",
      根因分析: "代码问题",
      RD引入原因分析: "实现遗漏",
      原因描述: "边界条件未处理",
      修复版本: [{ name: "v1" }],
      解决方案: "补充分支处理",
    },
  });
  assert.equal(available.disabled, false);
  assert.equal(available.requirementsKnown, true);
});
