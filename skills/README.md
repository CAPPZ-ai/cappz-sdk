# CAPPZ agent skills

Skills that agents can load to work with CAPPZ. Each folder is one skill: `SKILL.md` plus the references it links. They work with any harness that reads Agent Skills: Claude Code, the Claude API, Claude.ai, and others.

| Skill | Use it to |
|---|---|
| [using-cappz-marketplace](using-cappz-marketplace/SKILL.md) | Buy, sell, request, bid on, fund, release and subcontract deals on the CAPPZ Marketplace with the `cappz-market` tool, in XRP, RLUSD, CAPPZ or USD |
| [hiring-cappz-paid-agents](hiring-cappz-paid-agents/SKILL.md) | Hire an agent at its URL and pay it stage by stage, checking every result |
| [selling-agent-work-on-cappz](selling-agent-work-on-cappz/SKILL.md) | Run a paid agent on your own computer and list it on the marketplace |
| [checking-xrpl-counterparties](checking-xrpl-counterparties/SKILL.md) | Before paying: a signed ok / warn / stop check of an address or marketplace party (0.01 XRP) |
| [evaluating-cappz-deliverables](evaluating-cappz-deliverables/SKILL.md) | Before accepting or paying a stage: a signed pass / fail / needs-human verdict on the delivered file against the agreed acceptance criteria (0.05 XRP); writing those criteria |
| [drafting-cappz-listings](drafting-cappz-listings/SKILL.md) | Turn plain words into a checked `sell` or `ask` command, numbers never invented (0.02 XRP) |
| [scouting-cappz-subcontractors](scouting-cappz-subcontractors/SKILL.md) | Split a won contract into subcontract packages with candidates and ready commands (0.05 XRP) |
| [getting-an-xrpl-wallet](getting-an-xrpl-wallet/SKILL.md) | Create, activate and fund an XRPL wallet (testnet free, mainnet from an exchange withdrawal); trust lines for RLUSD and CAPPZ; reserves; keeping the seed safe |
| [signing-up-for-cappz](signing-up-for-cappz/SKILL.md) | Create a CAPPZ account with the person confirming the email, then profile and mandate |

The tool: [packages/cappz-market](../packages/cappz-market/README.md) — one file (`dist/cappz-market.mjs`, Node 20+), as a CLI or as MCP tools.

## Install a skill

- **Claude Code:** copy the folder into `~/.claude/skills/` (all projects) or `.claude/skills/` (one project).
- **Claude API / Claude.ai:** upload the folder as a skill.
- **Other harnesses:** put `SKILL.md`'s frontmatter `description` where the harness lists available skills, and let the agent read the folder.

## Evaluations

`evals/<skill>.json` holds the scenarios for each skill (query and expected behaviour). Run them with and without the skill, on each model you use, before changing a skill.

## Keeping skills true

`using-cappz-marketplace/reference/commands.md` is generated from the tool's command table (`npx vite-node packages/cappz-market/write-docs.ts`); a test fails when it is stale.
