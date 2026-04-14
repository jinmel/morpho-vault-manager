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
- Reporting, auditability, and policy enforcement

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
- policy enforcement
- signing and broadcasting

Current integration mode is local subprocess access. Future direct SDK or local daemon integration is optional.

### 4. Morpho Tooling

Responsibilities:

- read Morpho vault and position state
- prepare unsigned transactions
- simulate transactions before execution

The initial assumption is `morpho-cli` plus vendored Morpho skill content.

## End-to-End Flow

### Configure

1. User runs `openclaw vault-manager configure`.
2. Plugin checks for required tools and daemon assumptions.
3. Plugin creates or imports an OWS wallet.
4. Plugin provisions an OWS API key with Morpho-specific policy constraints.
5. Plugin records the risk profile and allowed-vault config.
6. Plugin creates a dedicated OpenClaw agent workspace.
7. Plugin writes `AGENTS.md` standing orders into that workspace.
8. Plugin creates an isolated OpenClaw cron job for periodic execution.

### Rebalance Run

1. OpenClaw cron wakes the dedicated agent in an isolated session.
2. The agent reads standing instructions and current profile state.
3. The agent reads current Morpho positions and candidate vault state.
4. The agent computes target allocation and drift.
5. If action is needed, it prepares transactions with Morpho tooling.
6. The agent verifies simulation success and warnings.
7. The execution path sends prepared transactions to OWS.
8. OWS enforces policy before any token-backed decryption.
9. Allowed transactions are signed and broadcast.
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

`src/` does not exist yet. The harness comes first.

## Invariants

- The plugin must remain model-agnostic.
- All live writes must be policy-gated through OWS.
- Base-only and USDC-only must be enforceable mechanically, not just mentioned in prompts.
- Simulation failure is terminal for a run.
- Policy denial is terminal for a run.
- Live execution must be auditable from logs and evals.

## Required Future Modules

### Config/Profile Layer

- profile file loading
- risk profile resolution
- allowed-vault resolution

### OWS Adapter

- wallet lookup
- policy management
- API key management
- sign/send wrapper

### Morpho Adapter

- vault discovery
- position reads
- transaction preparation
- simulation handling

### Rebalance Engine

- scoring
- target weight computation
- drift detection
- execution plan generation

### OpenClaw Adapter

- agent bootstrap
- workspace file generation
- cron management
- reporting hooks

## Design Bias

- Prefer explicit adapters over direct shell calls spread across the codebase.
- Prefer deterministic scripts over undocumented shell recipes.
- Prefer narrow data contracts over implicit object blobs.
- Prefer a few hard constraints over a large prompt.
