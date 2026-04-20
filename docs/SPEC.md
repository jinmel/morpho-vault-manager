# OpenClaw Morpho Vault Manager Plugin Spec

Consolidated spec. Supersedes and folds in:

- `openclaw-vault-manager-spec.md` (main product spec)
- `openclaw-vault-manager-spec-revised-2026-04-15.md` (release/install tightening)
- `openclaw-vault-manager-spec-configure-wizard-automation.md` (zero-touch configure, 2026-04-17, shipped)
- `openclaw-vault-manager-spec-configurable-risk-params.md` (2026-04-16, planned — not yet implemented)

Last consolidated: 2026-04-17.

## Summary

Build a **native OpenClaw plugin** that gives OpenClaw users a guided way to create a constrained onchain wallet, fund it with USDC, and run a **periodic Morpho vault rebalancer** against that wallet.

The plugin should combine:

- **OpenClaw native plugin capabilities** for installability, CLI onboarding, agent configuration, and cron scheduling
- **Morpho skill content** vendored from [`morpho-org/morpho-skills`](https://github.com/morpho-org/morpho-skills/) so the agent has Morpho-specific operating instructions
- **Open Wallet Standard (OWS)** for wallet creation, agent access, and transaction signing/broadcast

The first release is **Base + USDC + Morpho vaults only**.

## Core Product Goal

After install, an OpenClaw user can run a single configure flow that:

1. creates or reuses a dedicated OWS wallet (zero-touch; bring-your-own-wallet supported via `--wallet`)
2. constrains agent access with an OWS API token (auto-provisioned; never pasted by the operator)
3. records the user's risk profile and rebalance preferences
4. guides the user to fund the wallet with USDC on Base
5. creates a dedicated OpenClaw agent workspace with standing instructions
6. creates an OpenClaw cron job that periodically rebalances the wallet
7. stores how cron summaries should be delivered for that specific managed agent

The end state is not a general DeFi copilot. It is a **narrow vault-management agent** with a small, auditable operating envelope.

## Non-Goals

- No custom Morpho transaction builder in v1. Use `morpho-cli` prepare/simulate flows.
- No multi-chain strategy in v1. Start with Base only.
- No custom OpenClaw model provider in v1.
- No custom OpenClaw `AgentHarness` in v1 unless we later introduce a separate native runtime that owns threads/sessions itself.
- No permissionless market rotation across arbitrary assets in v1. Restrict to approved USDC vaults.

## Key OpenClaw Decision

### Do not implement a custom OpenClaw `AgentHarness` in v1

OpenClaw's harness API is for native runtimes that own their own session model, compaction, or thread lifecycle. This plugin does not need that. The plugin ships as a **native OpenClaw capability plugin** that uses the existing OpenClaw agent runtime and cron system.

That means:

- the plugin registers CLI/setup surfaces and any helper tools it needs
- the vault-manager agent runs through the user's normal OpenClaw model path
- operators who want Codex can still choose `codex/*` models and the bundled Codex harness
- the plugin remains model-agnostic and easier to ship

If we later build a dedicated external daemon that owns long-lived portfolio-management sessions, then a true `registerAgentHarness(...)` path becomes justified.

## Why Native Plugin Instead of Bundle-Only

OpenClaw bundles are good for importing skills and MCP settings from Codex/Claude/Cursor ecosystems, but bundle support is intentionally narrower than native plugins. We need more than imported skills:

- a `configure` CLI subcommand
- onboarding logic with `clack`
- local file/state management
- agent workspace generation
- cron job creation
- OWS token provisioning

So the correct packaging for v1 is:

- **Primary format:** native OpenClaw plugin
- **Bundled content inside it:** vendored Morpho skill roots
- **Optional future add-on:** companion `.codex-plugin` / `.claude-plugin` metadata for reuse outside OpenClaw

## User Experience

### Install

```bash
openclaw plugins install @morpho/openclaw-vault-manager
openclaw plugins enable morpho-vault-manager
openclaw gateway restart
```

### Configure

```bash
openclaw vault-manager configure
```

Optional flags:

- `--profile <id>` — profile id (default `"default"`).
- `--wallet <ref>` — reuse an existing OWS wallet by name or UUID instead of auto-creating.
- `--wallet-passphrase-env <VAR>` — env var that holds the passphrase for `--wallet` (avoids the interactive masked prompt).
- `OWS_VAULT_MANAGER_WALLET` / `OWS_VAULT_MANAGER_WALLET_PASSPHRASE` env vars — equivalent to the flags above.

The configure flow uses `clack` and walks the user through (see the Configure Flow Spec section for details):

1. prerequisite checks (one Y/N confirm if `ows` needs auto-install)
2. wallet auto-resolve or auto-create (zero operator shell commands)
3. risk-profile survey
4. model/agent prompt selection
5. cron schedule and delivery target selection
6. deposit instructions + optional balance poll
7. validation dry-run

### Ongoing Use

After configuration, the plugin exposes these subcommands. All accept `--profile <id>` (default: `"default"`).

#### `status`

Show profile, workspace, cron, and token status. Accepts `--json` for machine-readable output.

Loads the profile from disk, checks whether the cron job is known to the gateway, and probes the configured token source for readiness. Displays wallet address, risk config, schedule, delivery target, model preference, last funded check, and last validation run.

#### `show`

Visualize the current onchain exposure for the profile's wallet. Reads from the Morpho GraphQL API (`https://api.morpho.org/graphql`) rather than the local morpho-cli subprocess so that it can surface the market-level allocations behind each vault position. Accepts `--json`, `--address <hex>` to inspect an address other than the profile wallet, `--chain-id <n>` to target a non-Base chain, `--endpoint <url>` to point at an alternate GraphQL endpoint, and `--no-color` to disable ANSI styling.

Output (non-JSON mode) has three sections:
1. **Header** — owner address, chain id, vault count, total USD supplied.
2. **Vault exposure** — one row per vault position with supplied USD, share of total, a unicode bar, and net APY.
3. **Market exposure per vault** — for each vault, a per-market table showing the vault's allocation to each underlying Morpho market (collateral / loan pair, LLTV, vault→market supply USD, share of vault TVL, and the user's pro-rata share of that market).

Rendering uses the `table` (gajus) npm package for ANSI-aware column layout, with unicode block characters (`█▉▊▋▌▍▎▏`) generated in-process for exposure bars. This is a read-only view. It does not sign, broadcast, or mutate profile state. Empty positions render as `No vault positions.` without failing.

#### `plan`

Compute a deterministic rebalance plan without executing any transactions. Accepts `--json`.

Calls the rebalance engine to score candidate vaults, compute target allocations, evaluate drift, and produce a list of planned deposit/withdraw actions. Writes a receipt JSON and JSONL log to the data root. This is the same computation that the cron agent uses as its first step.

#### `allocate`

Invoke the agent to allocate funds into Morpho vaults. Queues an immediate cron run via `openclaw cron run` and returns without waiting for completion. The agent then computes a plan and executes through morpho-cli and OWS.

This is the recommended command for the initial deposit after configure, since the wallet typically starts with idle USDC and no vault positions.

> **Note:** `allocate` and `run-now` are functionally identical — both queue an immediate cron execution. `allocate` is named for the initial funding use case; `run-now` is for ad-hoc rebalance triggers.

#### `run-now`

Queue an immediate cron run for the profile. Same behavior as `allocate`.

#### `pause`

Disable the profile's cron job. Calls `openclaw cron disable`, sets `cronEnabled: false` on the profile, and saves. No confirmation prompt.

#### `resume`

Enable the profile's cron job. Calls `openclaw cron enable`, sets `cronEnabled: true` on the profile, and saves. No confirmation prompt.

#### `reconfigure`

Re-run the full configure flow for an existing profile. Identical to `configure` but pre-populates prompts with the profile's current values. Accepts the same wallet-override flags as `configure`.

#### `teardown`

Remove all resources created by configure for a profile. Accepts `--all`, `--force`, and `--keep-logs`.

Deletion sequence:

1. Delete the cron job via `openclaw cron remove`
2. Delete the OpenClaw agent via `openclaw agents delete`
3. Remove the agent workspace directory
4. Remove run logs and receipts (unless `--keep-logs`)
5. Delete the profile file
6. Remove the wallet marker file at `~/.openclaw/vault-manager/state/<profileId>.wallet.json`

Shows a confirmation prompt unless `--force` is set. Errors are accumulated and reported rather than failing on the first error. If the profile file is missing, teardown still attempts to clean up derived resources (agent, workspace, marker).

`--all` discovers all profile IDs and tears down each one in sequence.

#### `history`

Show past rebalance plan runs persisted locally under `{dataRoot}/runs/{profileId}/`, with enriched metrics derived from the receipts on disk. `history` is **read-only**: it never calls OWS, never issues an RPC, and never writes new artifacts.

The subcommand exposes four views:

- **Default list** — a table of recent runs (columns: short runId, `createdAt`, status, `maxDriftPct`, action count, planned turnover USDC, selected vault count), sorted by `createdAt` descending. An empty history is not an error; the command prints a "no history" note and exits 0.
- `--run <runId>` — print the full receipt for a single run plus a per-run enrichment block (planned turnover as a percentage of managed USDC, action counts by kind, and per-vault allocation deltas versus the prior run). Accepts either a full UUID or a unique prefix (min 6 chars); ambiguous or unknown prefixes exit non-zero.
- `--logs <runId>` — stream the JSONL event log for a run to stdout. The log is already redacted at write time, so `history` does not re-redact.
- `--json` — emit `{ profileId, runs: PlanResult[], metrics: HistoryAggregateMetrics }` as a single JSON document. No ANSI, no prompts, no mixed stdout text.

Filters compose across the list and aggregate metrics:

- `--since <iso>` — include only runs with `createdAt >= <iso>`.
- `--status <planned|no_op|blocked>` — filter by run status.
- `--limit <n>` — cap the number of runs returned (default `20`).

`history` shows **plan runs persisted locally**. Transaction hashes and on-chain outcomes live in the OpenClaw task output and the block explorer, not in these receipts; operators investigating onchain execution should consult those surfaces instead.

The actual periodic execution uses **OpenClaw cron**, not a custom scheduler.

## Scope of the MVP Strategy

### Supported asset universe

- Chain: `base` / `eip155:8453`
- Asset: USDC on Base
- Strategy: allocate USDC across Base USDC Morpho vaults discovered via `morpho query-vaults`

### Supported decisions

- choose among USDC vaults returned by `morpho query-vaults` on Base
- rebalance when allocation drift exceeds configured thresholds
- keep a small USDC cash buffer if configured
- skip execution when simulation fails or OWS signing fails

### Unsupported in v1

- leverage loops
- borrowing strategies
- cross-chain moves
- arbitrary token swaps
- any contract interaction not produced by a Morpho CLI prepare flow

## Architecture

### 1. Native OpenClaw plugin

The plugin ships:

- `package.json` with `openclaw.extensions` pointing at compiled JS
- `openclaw.plugin.json`
- `index.ts` plugin entry (compiled to `dist/`)
- a CLI module for `vault-manager` commands
- vendored skill directories
- prompt templates

### 2. Vendored Morpho skills

The rebalance runtime uses `morpho-cli` directly. Morpho skill content is installed as a workspace skill from [`morpho-org/morpho-skills`](https://github.com/morpho-org/morpho-skills/) so agents have Morpho-specific operating instructions available via the skill system. The critical skill for v1 is `morpho-cli`, which documents:

- `query-vaults`
- `get-vault`
- `get-positions`
- `prepare-deposit`
- `prepare-withdraw`
- `simulate-transactions`

This lets the agent use a stable protocol workflow:

1. read vault universe
2. read current wallet positions
3. prepare unsigned transactions
4. inspect simulation output
5. pass approved transactions to OWS for signing, then broadcast with a constrained wrapper since the current OWS CLI surface only exposes signing

### 3. OWS integration model

Use **OWS local subprocess access** first. Why:

- it matches the OWS "local subprocess" access profile
- it avoids embedding wallet logic into the plugin
- it is straightforward to audit and replace later

The plugin shells out to `ows` for:

- wallet create/import/list
- API key create/revoke
- sign, with future `signAndSend` if/when the CLI exposes a documented surface

Phase 2 can add direct library bindings or a local OWS daemon.

### 4. OpenClaw agent workspace

The configure flow creates a dedicated agent, e.g.:

- agent id: `vault-manager`
- workspace: `~/.openclaw/workspace-vault-manager`

The plugin writes an `AGENTS.md` file into that workspace. That file holds the persistent operating program: mandate, risk profile, candidate-vault discovery rule, rebalance rules, escalation rules, reporting format.

The cron job sends only a short message:

> Execute the Morpho vault rebalance program in AGENTS.md for the configured wallet. Use current onchain state and the documented runtime checks.

This is the right OpenClaw shape: standing orders belong in `AGENTS.md`, while cron defines when to execute them.

### 5. OpenClaw cron

Use an **isolated cron job** for rebalancing. Recommended shape:

- `--session isolated`
- dedicated `--agent vault-manager`
- explicit `--message`
- optional `--model` override
- `--announce` when the user wants notifications
- default `--channel last` for seamless delivery back to the operator's most recent OpenClaw chat route
- optional explicit `--channel telegram --to ...` for per-agent pinned delivery targets

Reasons: isolated cron is the OpenClaw path for detached background chores; cron persists jobs across restarts; every run gets a task record; delivery, retries, and audit trail already exist. The plugin must not build its own scheduler.

Cron delivery configuration is stored on the plugin's per-agent profile, not in shared global plugin state, because different vault-manager agents may need to report to different Telegram groups/topics.

Recommended behavior:

- if the operator chooses notifications and no explicit target is pinned, create the cron job with `--announce --channel last`
- if the operator wants a fixed Telegram destination, discover candidate groups/topics via `openclaw directory groups list --channel telegram` and store the selected target on that profile
- if multiple Telegram accounts exist, store the chosen OpenClaw channel account id alongside the target
- if the operator chooses `none`, create the cron job with `--no-deliver`

### 6. Configure Wizard Automation (shipped 2026-04-17)

A dedicated adapter module `src/lib/ows-bootstrap.ts` owns every OWS subprocess invoked during onboarding so the operator never runs OWS commands by hand.

**Adapter surface:**

```ts
ensureOwsInstalled(settings, { confirmInstall }): Promise<{ status, stderr?, hint? }>
resolveOrCreateWallet(settings, { profileId, override? }): Promise<WalletResolution>
provisionApiKey({ settings, walletRef, keyName, passphrase }): Promise<{ token }>
writeTokenToOpenclawEnv(settings, envVar, token): Promise<void>
```

Plus three pure, unit-testable parsers:

- `parseOwsWalletCreateOutput` → `{ walletRef, walletAddress, mnemonic }`
- `parseOwsWalletList` → `Array<{ name, walletRef, evmAddress? }>`
- `parseOwsKeyCreateOutput` → `{ token }`

**Wallet marker file:** `~/.openclaw/vault-manager/state/<profileId>.wallet.json` (mode 0600). Holds `{ walletRef, walletAddress, passphrase, mnemonic?, source, canonicalName, createdAt }`. `mnemonic` is present only for auto-created wallets; operator-provided wallets omit it. Written by `ows-bootstrap`, read by `configure` / `reconfigure`, removed by `teardown`.

**Wallet resolution precedence (first match wins):**

1. **Marker reuse** — reuse `{ walletRef, walletAddress, passphrase }` silently.
2. **Operator override** — `--wallet <ref>` (or `OWS_VAULT_MANAGER_WALLET`). Passphrase source: `--wallet-passphrase-env <VAR>` → `OWS_VAULT_MANAGER_WALLET_PASSPHRASE` → masked `p.password` prompt. Marker is written only after `provisionApiKey` succeeds, so a bad passphrase never persists.
3. **Zero-touch auto-create** — generate a 32-byte hex passphrase, run `ows wallet create --name <canonical> --show-mnemonic` with `OWS_PASSPHRASE=<passphrase>`, parse stdout, write marker immediately. If the canonical name (`morpho-vault-manager` or `morpho-vault-manager-<profileId>`) is already present in `ows wallet list`, create with a `-<unixTimestamp>` suffix and emit a note pointing at `--wallet` for reuse.

**API key provisioning:** after wallet resolution the plugin runs `ows key create --name <agentId>-agent --wallet <walletRef>` with `OWS_PASSPHRASE=<passphrase>`. No `--policy` flag — runtime gates in the plugin enforce Base/USDC/morpho-cli-prepared invariants. The captured `ows_key_...` token is written into `openclaw.json` via `openclaw config set env.vars.<VAR>`. Tokens are rotated on every `configure`/`reconfigure` run.

**Bad-passphrase handling (override path only):** `ows key create` is the point at which a wrong passphrase surfaces. The wizard re-prompts once; a second failure aborts without persisting the marker or token.

**Redaction:** `src/lib/run-logger.ts` redacts `ows_key_...` tokens and any `Created wallet ...` echoes from run logs. The bootstrap adapter captures `ows wallet create --show-mnemonic` stdout in memory and never echoes it to the terminal or JSONL log.

## Security Model

### Core rule: the agent never receives the owner credential

OWS distinguishes:

- **owner credential**: full wallet access
- **API token**: delegated agent access

The plugin only provisions the agent with an **OWS API token**, never the owner passphrase directly.

For auto-created wallets, the plugin holds the wallet passphrase (owner-equivalent material) in `~/.openclaw/vault-manager/state/<profileId>.wallet.json` (mode 0600) so `configure`/`reconfigure` can provision API keys non-interactively. Protecting this file is the operator's responsibility. This is an intentional relaxation of the "owner credential never enters plugin state" invariant in exchange for single-command onboarding; the running agent never accesses this file.

### Runtime enforcement model

The plugin does not create or manage custom OWS policies. It relies on OWS defaults and constrains execution at the runtime layer.

The rebalance runtime only forwards calldata produced by `morpho-cli` prepare flows to OWS — it has no code path that accepts agent-authored calldata — so the trust boundary for destination addresses is the Morpho CLI prepare surface.

### Runtime checks the plugin must enforce

- Base only
- USDC-only vault operations
- no agent-authored calldata reaches signing
- max notional per rebalance run
- optional max concentration per vault
- simulation must succeed before signing

### Secret handling

The wallet passphrase for auto-created wallets is generated by the plugin and stored at `~/.openclaw/vault-manager/state/<profileId>.wallet.json` (mode 0600). This is owner-equivalent material; protecting the file is the operator's responsibility.

The OWS API token transits plugin process memory during `configure` (captured from `ows key create` stdout and forwarded to `openclaw config set env.vars.<VAR>`). It is not persisted to plugin files and is rotated on every configure run.

Mnemonic output from `ows wallet create --show-mnemonic` is captured directly into the marker file and never echoed to terminal or logs. `ows_key_...` tokens are redacted value-wise in JSONL run logs.

### Storage rules

- Do not commit secrets to the repo.
- Do not write owner credentials into OpenClaw prompts or workspace files.
- API tokens must be resolved through the configured token source (`env` or `file`), never hardcoded in profile JSON or plugin config.
- Wallet marker files MAY hold a wallet passphrase and mnemonic for auto-created wallets. They live at `~/.openclaw/vault-manager/state/<profileId>.wallet.json` with mode 0600 and are removed by `teardown`.
- Profile files may contain public addresses, wallet IDs, thresholds, cron metadata, delivery targets/account ids, and the token source descriptor (kind + identifier), never the token value itself.

## Configure Flow Spec

### Step 0. Preflight

Check:

- OpenClaw gateway is installed and reachable
- `ows` is installed and on `PATH`
- `bunx @morpho-org/cli health-check` passes

If `ows` is missing, the wizard offers a single Y/N confirm and runs the official installer (`curl -fsSL https://docs.openwallet.sh/install.sh | bash`). If the install succeeds but the binary is still off PATH, the wizard instructs the operator to restart their shell (no auto-edit of rc files).

If the OpenClaw gateway is not set up as a daemon, the wizard warns and offers instructions. This is mandatory because cron runs inside the gateway process.

### Step 1. Wallet setup

The plugin auto-resolves or creates the OWS wallet without asking the operator to run OWS commands. Resolution order:

1. If the profile has a marker file at `~/.openclaw/vault-manager/state/<profileId>.wallet.json`, reuse it.
2. If the operator passed `--wallet <ref>` (or set `OWS_VAULT_MANAGER_WALLET`), match that name/UUID against `ows wallet list` and accept a passphrase from `--wallet-passphrase-env`, `OWS_VAULT_MANAGER_WALLET_PASSPHRASE`, or an interactive masked prompt.
3. Otherwise, create a dedicated wallet (`morpho-vault-manager` or `morpho-vault-manager-<profileId>`) with a plugin-generated passphrase. Capture the mnemonic via `--show-mnemonic` and store everything in the marker file (mode 0600).

The wizard never asks the operator to copy `ows wallet create` commands or paste back public addresses.

### Step 2. Agent-access provisioning

The plugin runs `ows key create` itself — with the wallet passphrase from the marker file (or override) — and captures the resulting `ows_key_...` token from stdout. The token is written into `openclaw.json` via `openclaw config set env.vars.<var>`. The operator never pastes the token.

The key is scoped to exactly one wallet in v1. Policy attachment (`--policy`) is not used; runtime gates in the plugin enforce the Base/USDC/morpho-cli-prepared invariants before any transaction reaches OWS.

### Step 3. Risk profile survey

Initial preset profiles:

- `conservative`
- `balanced`
- `aggressive`

Each preset maps to concrete execution rules.

Suggested v1 mapping:

#### Conservative

- 1-2 vaults max
- prefer highest TVL / most established vaults
- ignore temporary reward APR spikes unless user opts in
- max 60% concentration in a single vault
- rebalance only when drift > 10%
- minimum position size: $100

#### Balanced

- 2-3 vaults
- optimize for APY subject to TVL floor
- allow moderate concentration
- rebalance when drift > 7.5%
- minimum position size: $50

#### Aggressive

- 2-4 vaults
- chase net APY more actively
- accept lower TVL floor
- rebalance when drift > 5%
- minimum position size: $25

The wizard shows the exact machine-readable config created for the selected profile.

### Step 4. Funding guidance

The plugin should not attempt to swap or bridge in v1.

Instead, it should:

- show the Base wallet address
- explain the user must deposit **USDC on Base**
- optionally poll until funds arrive
- offer a "continue once funded" loop

The plugin uses OWS wallet info plus Morpho position reads to confirm funding state.

### Step 5. Agent prompt / standing order generation

Generate `AGENTS.md` from a template plus user answers.

The standing order defines:

- wallet identity
- chain and asset restrictions
- candidate-vault discovery rule
- target allocation algorithm
- max turnover per run
- no-op conditions
- escalation rules
- reporting format

### Step 6. Model selection

Default behavior: use the user's existing OpenClaw model path.

Optional advanced path: choose a dedicated model for the vault-manager agent; if the user already runs Codex, allow `codex/*` models.

The plugin does not own the harness. It only stores agent preferences.

### Step 7. Cron setup

Create a recurring isolated cron job, for example:

```bash
openclaw cron add \
  --name "Morpho Vault Rebalance" \
  --cron "0 */6 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --agent vault-manager \
  --message "Execute the Morpho vault rebalance program in AGENTS.md for the configured wallet. Use live state, simulate before execution, and report actions or no-op reasons." \
  --announce \
  --channel last
```

If the operator pins a Telegram delivery destination for this specific profile, the plugin instead creates or edits the cron job with explicit delivery flags such as:

```bash
openclaw cron edit <job-id> \
  --announce \
  --channel telegram \
  --account default \
  --to "-1001234567890:topic:42"
```

Default cadence for v1: every 6 hours.

Optional presets: hourly, every 6 hours, daily, weekdays only.

### Step 8. Validation run

Run a final dry-run rebalance:

- fetch vault candidates
- fetch current wallet state
- compute recommended allocation
- prepare transactions if needed
- simulate
- stop before signing unless the user explicitly opts into a live test

## Rebalance Engine Spec

### Inputs

- OWS wallet descriptor + agent API token
- risk profile config
- current Morpho positions
- candidate vault data from `query-vaults` (Base USDC)

### Read path

1. resolve the wallet address from OWS
2. read current Morpho positions for that address on Base
3. query candidate USDC vaults on Base
4. enrich vaults with APY, TVL, fee, rewards, version

### Allocation algorithm

Keep it deliberately simple.

#### Candidate filtering

Start from `morpho query-vaults --chain base`. Discard vaults that fail:

- chain != Base
- asset != USDC
- below minimum TVL threshold
- version/status not supported by the plugin

#### Scoring

Use a transparent risk-adjusted score:

```text
score = apy_weight * net_apy
      + tvl_weight * normalized_tvl
      - fee_weight * fee_pct
      - concentration_penalty
      - rewards_penalty_if_profile_dislikes_rewards
```

The profile sets the weights.

#### Target allocation

Choose the top N vaults for the selected profile and normalize their scores into target weights, subject to:

- per-vault max concentration
- minimum position size
- max turnover per run
- optional cash buffer

#### Drift rule

Do nothing unless:

- weight drift exceeds threshold
- or the current top vault set changed materially

### Execution path

For each required move:

1. prepare Morpho unsigned transactions
2. inspect `simulation.allSucceeded`
3. inspect warnings
4. pass each transaction to OWS for signing, then broadcast with the constrained wrapper since `signAndSend` is not yet available in the current CLI surface
5. record receipts and summarize outcome

If any simulation fails, the run stops and reports failure. No fallback heuristics that invent alternate transactions.

## Agent Behavior Contract

The agent must follow this order every run:

1. read live state
2. compute target allocation
3. explain why action is or is not needed
4. prepare transactions
5. verify simulation
6. execute only through the provided runtime wrapper
7. report the result

Required no-op cases:

- no USDC balance and no current positions
- drift below threshold
- simulation failure
- unsupported vault encountered

Required escalation cases:

- proposed move exceeds configured turnover cap
- a non-USDC vault position or non-vault Morpho market position is detected on the managed wallet
- repeated run failures

## State Model

The plugin persists a per-profile JSON file with the following shape:

```json
{
  "profileId": "default",
  "walletId": "uuid",
  "walletAddress": "0x...",
  "chainId": "eip155:8453",
  "asset": {
    "symbol": "USDC",
    "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "decimals": 6
  },
  "riskProfile": "balanced",
  "riskPreset": {
    "id": "balanced",
    "maxVaults": 3,
    "maxSingleVaultPct": 0.5,
    "rebalanceDriftPct": 0.075,
    "minimumPositionUsd": 50,
    "maxTurnoverUsd": 10000,
    "minimumVaultTvlUsd": 2500000,
    "rewardPreference": "neutral",
    "scoreWeights": {"apy": 1.0, "tvl": 0.5, "fee": 0.6, "rewardsPenalty": 0.0}
  },
  "cashBufferUsd": 100,
  "agentId": "vault-manager",
  "cronJobName": "Morpho Vault Rebalance",
  "notifications": "announce",
  "deliveryChannel": "last",
  "deliveryTo": null,
  "deliveryAccountId": null
}
```

The wallet passphrase and mnemonic are NOT stored in the profile file — they live only in the separate marker file at `~/.openclaw/vault-manager/state/<profileId>.wallet.json`.

Durable source of truth:

- OWS wallet state
- Morpho live reads
- plugin profile JSON + wallet marker file

Do not use model transcript history as durable state.

## Proposed OpenClaw Config Surface

Suggested plugin config shape:

```json5
{
  plugins: {
    entries: {
      "morpho-vault-manager": {
        enabled: true,
        apiKey: {
          source: "env",
          provider: "default",
          id: "OWS_MORPHO_VAULT_MANAGER_TOKEN"
        },
        config: {
          profilePath: "~/.openclaw/vault-manager/default.json",
          owsCommand: "ows",
          morphoCliCommand: "bunx",
          morphoCliArgsPrefix: ["@morpho-org/cli"],
          defaultChain: "base",
          defaultDeliveryMode: "announce",
          defaultDeliveryChannel: "last",
          dryRunByDefault: false
        }
      }
    }
  }
}
```

## Prompt Template Requirements

The generated `AGENTS.md` encodes rules like:

- only manage the configured wallet
- only operate on Base
- only manage USDC Morpho vault positions
- candidate vaults come from `morpho query-vaults`, not from any other source
- always simulate before signing
- never hand-craft calldata and never invent alternate transactions if CLI preparation fails
- never use owner credentials
- report execute/verify details after each run

This keeps model behavior narrow even if the surrounding OpenClaw environment has more tools available.

## Shipping Plan

### Distribution

Ship as an installable native plugin on:

- ClawHub
- npm as fallback

Recommended package identity:

- npm: `@morpho/openclaw-vault-manager`
- OpenClaw plugin id: `morpho-vault-manager`

### Install path for users

```bash
openclaw plugins install @morpho/openclaw-vault-manager
openclaw plugins enable morpho-vault-manager
openclaw gateway restart
openclaw vault-manager configure
```

### Packaging requirements (from 2026-04-15 release/install revision)

The published package **must** include:

- compiled plugin entrypoint
- compiled CLI/runtime modules
- plugin manifest
- required runtime scripts
- required skills and references
- operator-facing release documentation (README, SECURITY, ARCHITECTURE)

The published package **must** exclude:

- eval-only entrypoints
- dev-only binaries
- local state files
- progress tracking files
- env files
- implementation-only fixtures not needed at runtime

### Build requirement

`npm pack` for the release candidate must build the runtime artifact as part of packaging. The release process must not rely on a human remembering to build first.

### Runtime packaging invariants

- `openclaw.extensions` must point at compiled JS
- the installed plugin must not depend on unresolved `.ts` import paths
- the install artifact must remain executable after extraction into `~/.openclaw/extensions/...`
- Source TypeScript may still be included for repository ergonomics, but runtime execution must depend on compiled assets.

### Safe-install requirement

Release artifacts must install through:

```bash
openclaw plugins install @morpho/openclaw-vault-manager
```

or an equivalent packed artifact path, **without** requiring `--dangerously-force-unsafe-install`. If the plugin requires the unsafe override, the release is blocked.

### Compatibility

The plugin should work with:

- normal OpenClaw provider/model routing
- optional Codex deployments via `codex/*`

It should not assume any single model provider.

### Compatibility floor

The minimum supported OpenClaw gateway version is **not** the first version that can discover the plugin, show metadata, or print root help. It is the first version that can successfully complete the full installed-plugin command path:

- install
- enable
- gateway restart
- `openclaw vault-manager --help`
- `openclaw vault-manager configure ...`
- `openclaw vault-manager status ...`
- `openclaw vault-manager plan ...` (and dry-run variants)

If a version only supports metadata/help but fails the command path, it is below the supported floor. At the time of the 2026-04-15 revision, OpenClaw `2026.4.2` was **not** sufficient for full installed-plugin command execution; the floor is therefore `2026.4.12` or newer (matching the value declared in `package.json` → `openclaw.compat.minGatewayVersion`).

## Release QA Requirements

Release QA must explicitly include:

- packed-artifact install test
- safe-install verification with no unsafe override
- post-restart command execution through `openclaw`
- command-level verification on the declared minimum supported gateway version

Repository-local checks (typecheck, evals, package allowlist verification) remain necessary but are not sufficient on their own.

### Required release gate

Before publish, the release process must fail closed unless all of the following pass:

```bash
npm run typecheck
scripts/check/evals
scripts/check/publish
npm pack
openclaw plugins install <packed artifact>
openclaw plugins enable morpho-vault-manager
openclaw gateway restart
openclaw vault-manager --help
```

and then the configured post-install command checks on the declared supported OpenClaw version.

### Source of truth for release claims

For distribution and installability, the source of truth is:

1. the packed artifact contents
2. the installed plugin behavior inside OpenClaw
3. the verified gateway version used during release QA

Repository source layout is not sufficient evidence for release claims if the packed artifact behaves differently after installation.

## Rollout Phases

### Phase 1: Safe MVP (complete)

- native OpenClaw plugin
- `configure` flow with `clack`, zero-touch OWS wallet + API key automation
- Base-only USDC vault manager
- OWS subprocess integration via `src/lib/ows-bootstrap.ts`
- vendored `morpho-cli` skill
- isolated cron job
- dry-run + live-run support
- `status`, `plan`, `allocate`, `run-now`, `pause`, `resume`, `reconfigure`, `teardown`
- runtime-gated prepare-only execution (destination contracts come from `morpho-cli` prepare flows, never from agent-authored calldata)

### Phase 2: Better operator ergonomics

- dashboard/status views
- richer notifications
- optional `morpho-builder` skill bundling for advanced users
- configurable drift threshold and minimum position size (see Planned Work below)

### Phase 3: Deeper runtime integration

- optional OWS local service mode
- multi-profile support
- optional custom OpenClaw harness only if we introduce an external native runtime

## Acceptance Criteria

### v1 product acceptance

1. a user can install the plugin via `openclaw plugins install`
2. `openclaw vault-manager configure` completes end-to-end on a fresh machine with zero OWS shell commands for the operator
3. the configure flow creates or reuses an OWS wallet via the documented resolution precedence
4. the agent only receives an OWS API token, never owner credentials, through normal runtime paths
5. the generated agent workspace contains standing orders in `AGENTS.md`
6. a cron job is created and visible in `openclaw cron list`
7. the rebalance loop can no-op cleanly
8. the rebalance loop can prepare, simulate, and execute an allowed deposit/withdrawal
9. disallowed transactions are blocked by runtime checks or OWS signing failure
10. every cron run produces a task/audit trail

### Release/install acceptance (from 2026-04-15 revision)

The plugin is release-ready only when all are true on a clean supported environment:

1. `openclaw plugins install @morpho/openclaw-vault-manager` succeeds without unsafe override
2. `openclaw plugins enable morpho-vault-manager` succeeds
3. `openclaw gateway restart` succeeds
4. `openclaw vault-manager --help` shows the expected subcommands
5. `openclaw vault-manager configure` starts successfully from the installed plugin
6. the installed plugin can execute its runtime modules without module-resolution errors
7. the package does not require repo-local source layout assumptions after install

### Configure wizard automation acceptance

1. `openclaw vault-manager configure` on a fresh machine completes with zero OWS shell commands for the operator to run and zero paste-backs.
2. `openclaw vault-manager configure --wallet <ref>` reuses an existing OWS wallet after a single masked passphrase prompt (or zero prompts if passphrase is env-supplied).
3. `openclaw vault-manager reconfigure` for a profile created under this flow produces no wallet/token prompts at all.
4. Parsers handle malformed OWS stdout without throwing (covered by `OBS-BOOT-PARSER-001..007` unit tests).
5. Mnemonic output from `ows wallet create --show-mnemonic` never appears in terminal output, run logs, or profile/marker file echo paths outside the marker itself.
6. Runtime security envelope unchanged: only `morpho-cli`-prepared calldata reaches OWS signing.
7. `teardown` removes the wallet marker file alongside the existing profile, workspace, agent, and cron cleanup.
8. `CFG-006..010` eval cases pass under `scripts/check/evals`.

## Planned Work (not yet implemented)

### Configurable drift threshold and minimum position size

Date proposed: 2026-04-16. Status: planned for Phase 2.

**Motivation.** The three risk presets hardcode `rebalanceDriftPct` and `minimumPositionUsd`. Operators who understand their portfolio may want to tighten or loosen these parameters without switching to an entirely different risk preset. Example: a $500k balanced portfolio may want a tighter 3% drift threshold while retaining balanced scoring weights; a small test portfolio may want a lower minimum position size.

**Proposed behavior (Step 3a, optional).** After risk preset selection, offer an optional customization step:

```
? Customize risk parameters for this profile? (advanced)
  ○ No — use the preset defaults (recommended)
  ○ Yes — adjust drift threshold and minimum position size
```

If the operator opts in, prompt per parameter:

- **Drift threshold (%)** — percentage input, stored as decimal on the profile. Validation: 1%–50% inclusive. Default: preset value.
- **Minimum position size (USD)** — integer USD. Validation: $1–$10,000 inclusive. Default: preset value.

**Reconfigure.** The customization step appears in `reconfigure` too, pre-populated with the profile's current values.

**Profile storage.** Overrides are written directly onto the `riskPreset` object on the profile. No separate "overrides" layer — the profile's `riskPreset` is already the effective config, and the preset `id` field records which base preset was used.

**AGENTS.md.** The generated AGENTS.md already reads from `profile.riskPreset`, so customized values automatically appear in the agent's standing orders. No template changes needed.

**Status display.** The `status` command should annotate when risk parameters differ from the base preset defaults:

```
Risk profile: balanced
  Drift threshold: 3.0% (preset default: 7.5%)
  Minimum position: $25 (preset default: $50)
```

If values match the preset, no annotation is needed.

**Validation rules:**

| Parameter | Min | Max | Type |
|-----------|-----|-----|------|
| `rebalanceDriftPct` | 0.01 (1%) | 0.50 (50%) | decimal |
| `minimumPositionUsd` | 1 | 10000 | integer USD |

Values outside these ranges should be rejected with a clear error message.

**Eval coverage (when implemented):** add a scenario verifying customized drift and minimum position values are stored on the profile's `riskPreset` and differ from the base preset defaults when overridden. Note: the original addendum proposed this as `CFG-006`, but that ID was taken by the configure wizard automation work; pick a fresh unused id when implementing.

**Scope.** This addendum only covers `rebalanceDriftPct` and `minimumPositionUsd`. Other risk parameters (`maxVaults`, `maxSingleVaultPct`, `maxTurnoverUsd`, `scoreWeights`) remain locked to preset values for v1. Extending customization to additional parameters is a natural follow-up but should be scoped separately.

## Open Questions

- Should the first live execution require a human-confirmed "armed mode" toggle after the dry run?
- Do we want one plugin profile per OpenClaw agent, or multi-profile support from day one?
- Do we vendor only `morpho-cli`, or also `morpho-builder` for future codegen workflows?

## Source Notes

Primary references used for this spec:

- OpenClaw docs index: <https://docs.openclaw.ai/llms.txt>
- OpenClaw agent harness docs: <https://docs.openclaw.ai/plugins/sdk-agent-harness.md>
- OpenClaw plugin bundles: <https://docs.openclaw.ai/plugins/bundles.md>
- OpenClaw plugin entry points: <https://docs.openclaw.ai/plugins/sdk-entrypoints.md>
- OpenClaw plugin setup/config: <https://docs.openclaw.ai/plugins/sdk-setup.md>
- OpenClaw plugin manifest: <https://docs.openclaw.ai/plugins/manifest.md>
- OpenClaw building plugins: <https://docs.openclaw.ai/plugins/building-plugins.md>
- OpenClaw multi-agent/workspace docs: <https://docs.openclaw.ai/concepts/multi-agent.md>, <https://docs.openclaw.ai/concepts/agent-workspace.md>
- OpenClaw cron/tasks/standing orders: <https://docs.openclaw.ai/automation/cron-jobs.md>, <https://docs.openclaw.ai/automation/tasks.md>, <https://docs.openclaw.ai/automation/standing-orders.md>
- OpenClaw secrets management: <https://docs.openclaw.ai/gateway/secrets.md>
- Open Wallet Standard overview and specs: <https://docs.openwallet.sh/>, <https://docs.openwallet.sh/md/02-signing-interface.md>, <https://docs.openwallet.sh/md/03-policy-engine.md>, <https://docs.openwallet.sh/md/04-agent-access-layer.md>, <https://docs.openwallet.sh/md/06-wallet-lifecycle.md>, <https://docs.openwallet.sh/md/07-supported-chains.md>, <https://docs.openwallet.sh/md/sdk-cli.md>
- Morpho skills repo: <https://github.com/morpho-org/morpho-skills/>
