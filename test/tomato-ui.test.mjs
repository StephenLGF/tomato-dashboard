import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const detailSource = await readFile(
  new URL("../web/src/components/TomatoTaskDetail.tsx", import.meta.url),
  "utf8",
);
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");

test("Bug details expose an unable-to-reproduce no-fix action", () => {
  assert.match(detailSource, /targetStatus: "不修复", label: "无法复现", noFixReason: "无法复现"/);
  assert.match(detailSource, /transitionTomatoItem\(itemKey, targetStatus, \{ noFixReason \}\)/);
  assert.match(apiSource, /JSON\.stringify\(\{ targetStatus, \.\.\.options \}\)/);
});

test("Tomato details expose a copy-link action beside the external link", () => {
  assert.match(detailSource, /tomato-detail-copy-button/);
  assert.match(detailSource, /复制 \$\{itemKey\} 番茄链接/);
  assert.match(detailSource, /onCopyLink\(externalUrl\)/);
});
