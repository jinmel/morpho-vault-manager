# Architecture

## Purpose

This repository will produce a native OpenClaw plugin that onboards a user into a constrained Morpho vault-management agent and runs that agent periodically through OpenClaw cron.

The architecture is intentionally narrow. The system is not a general trading bot and not a generic DeFi wallet manager.

## System Boundaries

### In Scope

- Native OpenClaw plugin packaging
- `configure` onboarding flow with `clack`
- OWS wallet creation/import and API-key provisioning
- Morpho data reads and transaction preparation
- Periodic rebalancing through OpenClaw cron
- Reporting and auditability

### Out of Scope for v1

- Cross-chain bridging
- Swaps
- Borrowing strategies
- Leverage
- Arbitrary smart-contract execution
- Custom OpenClaw agent harness runtime

## Major Components

### 1. OpenClaw Native Plugin

Responsibilities:

- expose CLI/setup entrypoints
- own plugin config and profile storage
- create/update the dedicated OpenClaw agent
- write standing instructions into the agent workspace
- create and manage cron jobs
- discover or persist per-profile cron delivery targets

### 2. OpenClaw Agent Runtime

Responsibilities:

- execute the periodic rebalance turn
- use the vendored Morpho skill guidance
- call local script entrypoints and future plugin tools
- report results through OpenClaw task and cron surfaces

This repo assumes the standard OpenClaw agent runtime. The plugin does not own session compaction, thread lifecycle, or model transport.

### 3. OWS

Responsibilities:

- wallet lifecycle
- API-key based agent access
- API-key provisioning may remain manual/out-of-process in v1 to keep the raw token out of plugin process memory
- signing
- future `signAndSend` support when a documented CLI surface exists

Current integration mode is local subprocess access. The current live wrapper signs through `ows sign tx` and then broadcasts through Base RPC because the documented OWS CLI reference does not currently document a `signAndSend` command. Future direct SDK or local daemon integration is optional.

### 4. Morpho Tooling

Responsibilities:

- read Morpho vault and position state
- prepare unsigned transactions
- simulate transactions before execution

The rebalance runtime uses `morpho-cli` directly. Morpho skill content is installed as a workspace skill from [`morpho-org/morpho-skills`](https://github.com/morpho-org/morpho-skills/) so agents have Morpho-specific operating instructions available via the skill system.

## End-to-End Flow

### Configure

1. User runs `openclaw vault-manager configure`.
2. Plugin checks for required tools and daemon assumptions.
3. Plugin creates or imports an OWS wallet.
4. Plugin emits OWS API-key provisioning instructions, and the operator completes token creation out-of-process so the raw token never enters plugin process memory.
6. Plugin records the risk profile.
7. Plugin offers funding guidance and an optional "continue once funded" balance poll against Morpho token reads.
8. Plugin offers optional model-routing preference for the dedicated agent.
9. Plugin creates a dedicated OpenClaw agent workspace.
10. Plugin writes `AGENTS.md` standing orders into that workspace.
11. Plugin configures cron delivery for that profile: default `channel=last`, or an explicit Telegram target discovered from OpenClaw directory surfaces.
12. Plugin creates an isolated OpenClaw cron job for periodic execution.
13. Plugin runs a final validation dry-run against live Morpho state and persists the outcome in the profile.

### Rebalance Run

1. OpenClaw cron wakes the dedicated agent in an isolated session.
2. The agent reads standing instructions and current profile state.
3. The agent reads current Morpho positions and candidate vault state.
4. The agent computes target allocation and drift.
5. If action is needed, it prepares transactions with Morpho tooling.
6. The agent verifies simulation success and warnings.
7. The execution path serializes each prepared transaction, then sends it to OWS for signing.
8. OWS signs with its default policy behavior; the plugin does not create or manage custom OWS policy artifacts.
9. The plugin wrapper broadcasts the signed transaction and waits for receipts.
10. The run verifies outcomes and reports results.

## Repository Structure Targets

This is the intended direction for the repo:

```text
.
├── AGENTS.md
├── ARCHITECTURE.md
├── SECURITY.md
├── docs/
│   ├── openclaw-vault-manager-spec.md
│   └── exec-plans/
│       └── active/
├── evals/
├── scripts/
│   ├── check/
│   ├── dev/
│   └── rebalance/
└── src/
    └── plugin implementation
```

`src/` now contains the native plugin, CLI surfaces, and the first rebalance runtime implementation.

## Invariants

- The plugin must remain model-agnostic.
- All live writes must be signed through OWS.
- Base-only and USDC-only must be enforceable mechanically, not just mentioned in prompts.
- The rebalance runtime must only forward `morpho-cli`-prepared transactions to OWS. Agent-authored calldata never reaches signing.
- Simulation failure is terminal for a run.
- Live execution must be auditable from logs and evals.

## Required Future Modules

### Config/Profile Layer

- profile file loading
- risk profile resolution

### OWS Adapter

- wallet lookup
- API key management
- sign wrapper plus broadcast/receipt verification

### Morpho Adapter

- vault discovery
- position reads
- transaction preparation
- simulation handling

### Rebalance Engine

- weighted scoring: `apy_weight * net_apy + tvl_weight * normalized_tvl - fee_weight * fee_pct - rewards_penalty`
- per-profile score weights and reward preference
- target weight computation
- drift detection
- execution plan generation

### OpenClaw Adapter

- agent bootstrap
- workspace file generation
- cron management
- delivery-target discovery (`channels list`, `directory groups list`)
- reporting hooks

## Design Bias

- Prefer explicit adapters over direct shell calls spread across the codebase.
- Prefer deterministic scripts over undocumented shell recipes.
- Prefer narrow data contracts over implicit object blobs.
- Prefer a few hard constraints over a large prompt.
