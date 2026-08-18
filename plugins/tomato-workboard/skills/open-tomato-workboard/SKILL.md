---
name: open-tomato-workboard
description: Open the local Tomato workboard when the user asks to view, inspect, or manage Tomato issues in Codex.
---

# 番茄工作台

This plugin opens the local Tomato workboard bundled with this repository.

1. Start the dashboard from the repository root with `npm start` if it is not already reachable.
2. Open the local dashboard at `http://127.0.0.1:47823/?project=tomato`.
3. Use the board to inspect the locally cached task state.

The board is backed by a local SQLite cache. The remote Tomato Team state is read and mutated through the local `gitee` CLI integration; Tomato MCP is not required by this plugin. If a Codex workflow needs live item details or comments beyond the board cache, it may use a separately configured Tomato MCP, but that is an optional user-side capability.
