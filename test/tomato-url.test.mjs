import assert from "node:assert/strict";
import { test } from "node:test";

import {
  tomatoItemKeyFromTask,
  tomatoItemUrl,
  tomatoWorkspaceKey,
} from "../shared/tomato-url.mjs";

test("Tomato item URLs match the Gitee Work card route", () => {
  assert.equal(tomatoWorkspaceKey("proxima-51491"), "proxima");
  assert.equal(tomatoWorkspaceKey("Gitee-Test-2026-546"), "gitee-test");
  assert.equal(
    tomatoItemUrl("proxima-51491", {
      origin: "https://osc.gitee.work",
      tenant: "example-tenant",
    }),
    "https://osc.gitee.work/_team/example-tenant/item/proxima-51491?workspace=proxima&tenant=example-tenant&hiddenHeader=true&from=one&frameless=true",
  );
  assert.equal(tomatoItemUrl(""), null);
  assert.equal(tomatoItemKeyFromTask({
    identifier: "TOMATO-1",
    title: "[proxima-51491] Card",
    description: "番茄事项：proxima-51491\n当前状态：新建",
  }), "proxima-51491");
});
