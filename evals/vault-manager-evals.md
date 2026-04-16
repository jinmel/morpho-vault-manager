# Vault Manager Eval Matrix

## Scope

These evals define the minimum deterministic behavior expected from the repository and, later, the plugin implementation.

## Matrix

| ID | Scenario | Setup | Expected Result | Validation Path |
| --- | --- | --- | --- | --- |
| `CFG-001` | Fresh machine preflight passes | `openclaw`, `ows`, and Morpho CLI available | Configure preflight returns success | `scripts/check/evals --only=CFG-001` |
| `CFG-002` | Missing dependency fails loudly | Simulated missing binary via settings override | Preflight returns non-ok with actionable message | `scripts/check/evals --only=CFG-002` |
| `CFG-003` | Gateway absence emits remediation-friendly warning | Temporary `openclaw` shim that exits non-zero on `gateway status` | Preflight reports `openclaw_gateway_unreachable` with daemon/status guidance | `scripts/check/evals --only=CFG-003` |
| `CFG-004` | Cron presets and risk config render deterministically | Helper exports from configure flow | Preset names map to exact cron expressions and risk config serializes as machine-readable JSON | `scripts/check/evals --only=CFG-004` |
| `CFG-005` | Cron delivery defaults render deterministically | Helper settings object | Default delivery mode/channel resolve to `announce` + `last` unless overridden | `scripts/check/evals --only=CFG-005` |
| `CFG-006` | Zero-touch auto-create: empty OWS + no marker → wallet + marker written | OWS wallet list returns empty; no marker in state | Wallet auto-created and marker persisted in state | `scripts/check/evals --only=CFG-006` |
| `CFG-007` | Marker reuse: existing marker short-circuits wallet list + create | Marker exists in state; wallet name resolvable | Configuration skips wallet creation and uses existing wallet from marker | `scripts/check/evals --only=CFG-007` |
| `CFG-008` | Operator override via `--wallet` selects existing wallet and threads passphrase | Multiple wallets in OWS; `--wallet` flag provided with name | Selected wallet is used and passphrase is correctly threaded through API key provisioning | `scripts/check/evals --only=CFG-008` |
| `CFG-009` | `provisionApiKey` surfaces `bad_passphrase` error code on passphrase rejection | Wallet exists; incorrect passphrase supplied | API key provisioning returns `bad_passphrase` error code without retry or recovery | `scripts/check/evals --only=CFG-009` |
| `CFG-010` | Canonical name collision: existing wallet with canonical name → suffixed create | Wallet with canonical name already exists in OWS | New wallet is created with suffixed name to avoid collision | `scripts/check/evals --only=CFG-010` |
| `WAL-001` | Wallet create command is deterministic and secret-free | Build wallet create + api key commands | Commands reference the wallet name and avoid inline secrets or plugin-managed policy flags | `scripts/check/evals --only=WAL-001` |
| `POL-001` | Provision API token only | Wallet exists | Agent credential is API token, not owner credential | future `configure` flow + logs |
| `CRN-001` | Cron environment is ready | OpenClaw gateway reachable | `openclawGatewayIsReachable` returns true | `scripts/check/evals --only=CRN-001` |
| `CRN-002` | Cron environment warns when gateway is absent | Simulated missing openclaw binary | `openclawGatewayIsReachable` returns false without throwing | `scripts/check/evals --only=CRN-002` |
| `REB-001` | Dry-run no-op with zero balance | Wallet funded with nothing and no positions | Rebalance returns no-op summary | `scripts/check/evals --only=REB-001` |
| `REB-002` | Dry-run no-op below drift threshold | Wallet already matches target allocation | Rebalance returns no-op summary with drift reason | `scripts/check/evals --only=REB-002` |
| `REB-003` | Dry-run produces transaction plan | Wallet has drift above threshold | Returns prepared transactions plus simulation summary | `scripts/check/evals --only=REB-003` |
| `REB-004` | Agent instructions enforce stop on first simulation failure | Generated AGENTS.md template | Template contains stop-on-failure rule in operating contract, procedure, and no-op conditions | `scripts/check/evals --only=REB-004` |
| `REB-005` | OWS signing failure blocks execution | Prepared tx cannot be signed by OWS | Live execution is aborted | `scripts/rebalance/live-run` |
| `REB-006` | Live run requires explicit arming | Valid prepared tx but no arming flag | Script refuses to execute | `scripts/rebalance/live-run` |
| `REB-007` | Allowed live execution succeeds | Valid prepared tx, successful simulation, arming enabled | Transaction(s) signed through OWS, broadcast on Base, and receipts reported | `scripts/rebalance/live-run` |
| `REB-008` | Turnover cap blocks instead of clipping | Proposed action set exceeds configured turnover cap | Rebalance is blocked with an explicit turnover-cap reason | `scripts/check/evals --only=REB-008` |
| `REB-009` | Non-vault Morpho market positions block execution | Wallet has a non-vault Morpho market position | Rebalance is blocked with an explicit non-vault-position reason | `scripts/check/evals --only=REB-009` |
| `REB-010` | Material top vault set changes trigger a rebalance | Current managed vault set differs from the current top-ranked set but drift remains below threshold | Rebalance still plans the repositioning actions | `scripts/check/evals --only=REB-010` |
| `REB-011` | Drift below threshold produces no-op | Positions slightly off target but drift below profile threshold | Rebalance returns no-op with drift-below-threshold reason | `scripts/check/evals --only=REB-011` |
| `REB-012` | Drift above threshold triggers rebalance | Positions significantly off target with drift above profile threshold | Rebalance returns planned with actions | `scripts/check/evals --only=REB-012` |
| `OBS-001` | Run logging is auditable | Any dry-run or live-run | Each run emits a JSONL log containing run id, phase transitions, final outcome, and no unredacted secrets | `scripts/check/evals --only=OBS-001` |

## Promotion Rule

A capability is not complete until its relevant row in this matrix has:

- a real implementation path
- a reproducible setup
- a pass/fail outcome that does not depend on manual interpretation

## Manual Release Verification

The deterministic evals above do not replace a fresh-machine install test from the packed or published plugin artifact.

Before release, run the checkbox sheet in [docs/release-qa-checklist.md](../docs/release-qa-checklist.md) and treat any unchecked release-blocking item as a ship stopper.
