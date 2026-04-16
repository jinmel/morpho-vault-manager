# OpenClaw Morpho Vault Manager Plugin Spec

## Summary

Build a **native OpenClaw plugin** that gives OpenClaw users a guided way to create a constrained onchain wallet, fund it with USDC, and run a **periodic Morpho vault rebalancer** against that wallet.

The plugin should combine:

- **OpenClaw native plugin capabilities** for installability, CLI onboarding, agent configuration, and cron scheduling
- **Morpho skill content** vendored from [`morpho-org/morpho-skills`](https://github.com/morpho-org/morpho-skills/) so the agent has Morpho-specific operating instructions
- **Open Wallet Standard (OWS)** for wallet creation, agent access, and transaction signing/broadcast

The first release should be **Base + USDC + Morpho vaults only**.

## Core Product Goal

After install, an OpenClaw user can run a single configure flow that:

1. creates or imports a dedicated OWS wallet
2. constrains agent access with an OWS API token
3. records the user’s risk profile and rebalance preferences
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

OpenClaw’s harness API is for native runtimes that own their own session model, compaction, or thread lifecycle. This plugin does not need that. The plugin should ship as a **native OpenClaw capability plugin** that uses the existing OpenClaw agent runtime and cron system.

That means:

- the plugin registers CLI/setup surfaces and any helper tools it needs
- the vault-manager agent runs through the user’s normal OpenClaw model path
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

The configure flow uses `clack` and walks the user through:

1. prerequisite checks
2. wallet creation/import
3. backup confirmation
4. risk-profile survey
5. deposit instructions
6. model/agent prompt selection
7. cron schedule creation
8. cron delivery target selection
9. dry-run or live rebalance test

### Ongoing Use

Useful follow-up commands:

```bash
openclaw vault-manager status
openclaw vault-manager run-now
openclaw vault-manager pause
openclaw vault-manager resume
openclaw vault-manager reconfigure
```

The actual periodic execution should use **OpenClaw cron**, not a custom scheduler.

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

The plugin should ship:

- `package.json` with `openclaw.extensions`
- `openclaw.plugin.json`
- `index.ts` plugin entry
- a CLI module for `vault-manager` commands
- vendored skill directories
- prompt templates

Suggested layout:

```text
openclaw-vault-manager/
  package.json
  openclaw.plugin.json
  index.ts
  cli/
    vault-manager.ts
    configure.ts
  skills/
    morpho-cli/...
    morpho-builder/...
    vault-manager/
      SKILL.md
  prompts/
    AGENTS.template.md
  docs/
    openclaw-vault-manager-spec.md
```

### 2. Vendored Morpho skills

Vendor the Morpho skill content from:

- `plugins/morpho-cli/skills/morpho-cli`
- optionally `plugins/morpho-builder/skills/morpho-builder`

The critical one for v1 is `morpho-cli`. It already documents:

- `query-vaults`
- `get-vault`
- `get-positions`
- `prepare-deposit`
- `prepare-withdraw`
- `simulate-transactions`

That lets the agent use a stable protocol workflow:

1. read vault universe
2. read current wallet positions
3. prepare unsigned transactions
4. inspect simulation output
5. pass approved transactions to OWS for signing, then broadcast with a constrained wrapper if the current OWS CLI surface only exposes signing

### 3. OWS integration model

Use **OWS local subprocess access** first.

Why:

- it matches the OWS “local subprocess” access profile
- it avoids embedding wallet logic into the plugin
- it keeps raw API-token handling out of plugin process memory in v1
- it is straightforward to audit and replace later

The plugin should shell out to `ows` for:

- wallet create/import/export guidance
- API key creation/revocation instructions and token-source wiring
- sign, and use `signAndSend` later if/when the CLI exposes a documented surface for it

Phase 2 can add direct library bindings or a local OWS daemon if needed.

### 4. OpenClaw agent workspace

The configure flow should create a dedicated agent, for example:

- agent id: `vault-manager`
- workspace: `~/.openclaw/workspace-vault-manager`

Recommended creation path:

```bash
openclaw agents add vault-manager --workspace ~/.openclaw/workspace-vault-manager
```

The plugin writes an `AGENTS.md` file into that workspace. That file holds the persistent operating program:

- mandate
- risk profile
- candidate-vault discovery rule (`morpho query-vaults` on Base filtered to USDC)
- rebalance rules
- escalation rules
- reporting format

The cron job then sends only a short message such as:

> Execute the Morpho vault rebalance program in AGENTS.md for the configured wallet. Use current onchain state and the documented runtime checks.

This is the right OpenClaw shape because standing orders belong in `AGENTS.md`, while cron defines when to execute them.

### 5. OpenClaw cron

Use an **isolated cron job** for rebalancing.

Recommended shape:

- `--session isolated`
- dedicated `--agent vault-manager`
- explicit `--message`
- optional `--model` override
- `--announce` when the user wants notifications
- default `--channel last` for seamless delivery back to the operator's most recent OpenClaw chat route
- optional explicit `--channel telegram --to ...` for per-agent pinned delivery targets

Reasons:

- isolated cron is the OpenClaw path for detached background chores
- cron persists jobs across restarts
- every run gets a task record
- delivery, retries, and audit trail already exist

The plugin must not build its own scheduler.

Cron delivery configuration should be stored on the plugin's per-agent profile, not in shared global plugin state, because different vault-manager agents may need to report to different Telegram groups/topics or other channels.

Recommended behavior:

- if the operator chooses notifications and no explicit target is pinned, create the cron job with `--announce --channel last`
- if the operator wants a fixed Telegram destination, discover candidate groups/topics via `openclaw directory groups list --channel telegram` and store the selected target on that profile
- if multiple Telegram accounts exist, store the chosen OpenClaw channel account id alongside the target
- if the operator chooses `none`, create the cron job with `--no-deliver`

## Security Model

### Core rule: the agent never receives the owner credential

OWS distinguishes:

- **owner credential**: full wallet access
- **API token**: delegated agent access

The plugin must only provision the agent with an **OWS API token**, never the owner passphrase.

### Runtime enforcement model

The plugin does not create or manage custom OWS policies. It relies on OWS defaults and constrains execution at the runtime layer instead.

The rebalance runtime only forwards calldata produced by `morpho-cli` prepare flows to OWS — it has no code path that accepts agent-authored calldata — so the trust boundary for destination addresses is the Morpho CLI prepare surface.

### Runtime checks the plugin should enforce

- Base only
- USDC-only vault operations
- no agent-authored calldata reaches signing
- max notional per rebalance run
- optional max concentration per vault
- simulation must succeed before signing

### Secret handling

The raw OWS API token should not live in plaintext config.

Preferred storage:

- plugin-supported `apiKey` or plugin config field backed by OpenClaw `SecretRef`
- or plugin-scoped env via `plugins.entries.<id>.env`

The configure command should not read the raw token into plugin process memory. Instead, it should emit the exact OWS API-key provisioning command, then record only an env/file/`SecretRef`-backed source descriptor for the resulting token.
The current implementation keeps the token out of plugin process memory by having the operator run `ows api-key create` manually and then point the plugin at an env-var, file-backed secret, or `SecretRef` source.

## Configure Flow Spec

### Step 0. Preflight

Check:

- OpenClaw gateway is installed
- the user understands cron requires the gateway to run continuously
- `ows` is installed and on `PATH`
- `bunx @morpho-org/cli health-check` passes

If the gateway is not set up as a daemon, the wizard should warn and offer instructions. This is mandatory because cron runs inside the gateway process.

### Step 1. Wallet setup

Offer:

- create a fresh wallet
- import an existing wallet

For create:

- default to a dedicated wallet name like `morpho-vault-manager`
- create a Base-capable OWS wallet
- display public address only
- require backup confirmation before continuing

### Step 2. Agent-access provisioning

For v1, this step intentionally keeps the raw token out of the wizard process. The operator runs the emitted OWS provisioning command in a separate shell, then points the plugin at the resulting env/file/`SecretRef` source.

Create or update:

- exact OWS API-key provisioning command and token-source wiring
- OWS API key for the vault-manager agent

The key should be scoped to:

- exactly one wallet in v1

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

#### Balanced

- 2-3 vaults
- optimize for APY subject to TVL floor
- allow moderate concentration
- rebalance when drift > 7.5%

#### Aggressive

- 2-4 vaults
- chase net APY more actively
- accept lower TVL floor
- rebalance when drift > 5%

The wizard should show the exact machine-readable config created for the selected profile.

### Step 4. Funding guidance

The plugin should not attempt to swap or bridge in v1.

Instead, it should:

- show the Base wallet address
- explain the user must deposit **USDC on Base**
- optionally poll until funds arrive
- offer a “continue once funded” loop

The plugin can use OWS wallet info plus Morpho position reads to confirm funding state.

### Step 5. Agent prompt / standing order generation

Generate `AGENTS.md` from a template plus user answers.

The standing order should define:

- wallet identity
- chain and asset restrictions
- candidate-vault discovery rule
- target allocation algorithm
- max turnover per run
- no-op conditions
- escalation rules
- reporting format

### Step 6. Model selection

Default behavior:

- use the user’s existing OpenClaw model path

Optional advanced path:

- choose a dedicated model for the vault-manager agent
- if the user already runs Codex, allow `codex/*` models

The plugin does not need to own the harness. It only stores agent preferences.

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

If the operator pins a Telegram delivery destination for this specific profile, the plugin should instead create or edit the cron job with explicit delivery flags such as:

```bash
openclaw cron edit <job-id> \
  --announce \
  --channel telegram \
  --account default \
  --to "-1001234567890:topic:42"
```

Default cadence for v1:

- every 6 hours

Optional presets:

- hourly
- every 6 hours
- daily
- weekdays only

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
4. pass each transaction to OWS for signing, then broadcast with the constrained wrapper if `signAndSend` is not available in the current CLI surface
5. record receipts and summarize outcome

If any simulation fails, the run should stop and report failure. No fallback heuristics that invent alternate transactions.

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

The plugin should persist a small machine-readable profile file, for example:

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
  "maxSingleVaultPct": 0.5,
  "rebalanceDriftPct": 0.075,
  "maxTurnoverUsd": 10000,
  "cashBufferUsd": 100,
  "agentId": "vault-manager",
  "cronJobName": "Morpho Vault Rebalance",
  "notifications": "announce",
  "deliveryChannel": "last",
  "deliveryTo": null,
  "deliveryAccountId": null
}
```

Avoid using model transcript history as durable state. The source of truth should remain:

- OWS wallet state
- Morpho live reads
- plugin config/profile JSON

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

The generated `AGENTS.md` should encode rules like:

- only manage the configured wallet
- only operate on Base
- only manage USDC Morpho vault positions
- candidate vaults come from `morpho query-vaults`, not from any other source
- always simulate before signing
- never hand-craft calldata and never invent alternate transactions if CLI preparation fails
- never use owner credentials
- report execute/verify details after each run

This keeps the model behavior narrow even if the surrounding OpenClaw environment has more tools available.

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

### Compatibility

The plugin should work with:

- normal OpenClaw provider/model routing
- optional Codex deployments via `codex/*`

It should not assume any single model provider.

## Rollout Phases

### Phase 1: Safe MVP

- native OpenClaw plugin
- `configure` flow with `clack`
- Base-only USDC vault manager
- OWS subprocess integration
- vendored `morpho-cli` skill
- isolated cron job
- dry-run + live-run support
- `status`, `pause`, `resume`, `run-now`
- runtime-gated prepare-only execution (destination contracts come from `morpho-cli` prepare flows, never from agent-authored calldata)

### Phase 2: Better operator ergonomics

- dashboard/status views
- richer notifications
- optional `morpho-builder` skill bundling for advanced users

### Phase 3: Deeper runtime integration

- optional OWS local service mode
- multi-profile support
- optional custom OpenClaw harness only if we introduce an external native runtime

## Acceptance Criteria

The plugin is ready for v1 when all are true:

1. a user can install it via `openclaw plugins install`
2. `openclaw vault-manager configure` completes end-to-end on a fresh machine
3. the configure flow creates an OWS wallet or imports one
4. the agent only receives an OWS API token, never owner credentials
5. the generated agent workspace contains standing orders in `AGENTS.md`
6. a cron job is created and visible in `openclaw cron list`
7. the rebalance loop can no-op cleanly
8. the rebalance loop can prepare, simulate, and execute an allowed deposit/withdrawal
9. disallowed transactions are blocked by runtime checks or OWS signing failure
10. every cron run produces a task/audit trail

## Open Questions

- Should the first live execution require a human-confirmed “armed mode” toggle after the dry run?
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
