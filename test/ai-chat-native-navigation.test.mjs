import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [chatSource, appSource, serverSource, styles] = await Promise.all([
  readFile(new URL("../web/src/components/AiChat.tsx", import.meta.url), "utf8"),
  readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../server/app.mjs", import.meta.url), "utf8"),
  readFile(new URL("../web/src/styles.css", import.meta.url), "utf8"),
]);

test("AI chat opens persisted conversations in their native Codex thread", () => {
  assert.match(chatSource, /onOpenThread\?: \(threadId: string, title\?: string\) => void/);
  assert.match(chatSource, /onOpenThread\(codexThreadId, thread\.title\)/);
  assert.match(chatSource, /if \(thread\.codexThreadId\) \{\s*openNativeThread\(thread\);\s*return;/);
  assert.match(chatSource, /在 Codex 原生对话中打开/);
  assert.match(chatSource, /在 Codex 原生对话中继续/);
});

test("App routes both inline Tomato and floating conversations through the native thread handler", () => {
  assert.ok((appSource.match(/onOpenThread=\{openThread\}/g)?.length ?? 0) >= 2);
  assert.match(appSource, /type: "taskboard:open-thread"/);
  assert.match(appSource, /payload: \{ threadId, \.\.\.\(title \? \{ title \} : \{\}\) \}/);
  assert.match(appSource, /openCodexThreadRequest\(normalizedThreadId\)/);
  assert.match(appSource, /已在 Codex 中打开对应对话/);
  assert.match(serverSource, /source: "tomato-workboard"/);
  assert.match(serverSource, /request: randomUUID\(\)/);
});

test("native conversation title keeps action buttons aligned to the right", () => {
  assert.match(styles, /\.ai-chat-panel-title\s*\{[\s\S]*?flex:\s*1;/);
  assert.match(styles, /> button:not\(\.ai-chat-panel-title\)/);
});

test("issue details expose one card-bound conversation without history or add controls", () => {
  assert.match(chatSource, /const singleIssueConversation = Boolean\(issueIdentifier\)/);
  assert.match(chatSource, /const visibleThreads = singleIssueConversation[\s\S]*?next\.slice\(0, 1\)[\s\S]*?: next;/);
  assert.match(chatSource, /\{!singleIssueConversation && \(\s*<>[\s\S]*?aria-label="对话历史"[\s\S]*?aria-label="新建对话"/);
});
