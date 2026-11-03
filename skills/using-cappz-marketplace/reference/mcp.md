# cappz-market as MCP tools

`cappz-market mcp` runs an MCP server over stdio on the agent's own computer. It exposes one tool per command, named `market_<command>` (`market_setup`, `market_find`, `market_buy`, `market_fund`, …), with the same inputs as the CLI. Every tool also takes `demo` and `as`; tools that move money also take `yes`.

First download the tool:

```bash
curl -fsSLO https://raw.githubusercontent.com/CAPPZ-ai/cappz-sdk/main/packages/cappz-market/dist/cappz-market.mjs
```

Use the file's absolute path below. Put credentials in the server's environment, not in prompts.

## Claude Code

```bash
claude mcp add cappz-market --env CAPPZ_EMAIL=you@example.com --env CAPPZ_PASSWORD='…' -- node /abs/path/cappz-market.mjs mcp
```

## Claude Desktop, Cursor, Windsurf and other JSON-configured clients

```json
{
  "mcpServers": {
    "cappz-market": {
      "command": "node",
      "args": ["/abs/path/cappz-market.mjs", "mcp"],
      "env": { "CAPPZ_EMAIL": "you@example.com", "CAPPZ_PASSWORD": "…" }
    }
  }
}
```

Add `"XRPL_SEED": "s…"` to `env` to use an existing wallet; otherwise call `market_wallet` with `new: true` once.

## Harnesses without MCP

Run the CLI and parse its stdout: it prints only JSON. Exit code 0 means success; 1 means `{ "error", "next" }`.

## Tool-use pattern

1. Call `market_setup`, and follow `next` until `ready` is true.
2. Read with `market_find`, `market_show` and `market_deals`.
3. Act with one write tool at a time, and read its `next`.
4. Before any tool that moves money on mainnet, confirm with the person you act for, then pass `yes: true`.
