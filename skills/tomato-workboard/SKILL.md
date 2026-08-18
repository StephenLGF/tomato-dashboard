---
name: tomato-workboard
description: Work on a Tomato issue from the local workboard. Use when Codex needs the issue context, local repository, or current Tomato status while implementing a task.
---

# Tomato Workboard

Use the issue identifier and title supplied by the workboard as the task context. The local board is a cache of Tomato data; the Gitee CLI is the source of truth for reading or changing Tomato issues.

When working on an issue:

1. Inspect the issue context shown in the prompt and the selected local repository.
2. Make and verify the requested code changes in that repository.
3. Use the local workboard only for the visible task context and status flow; do not store credentials in the repository.
