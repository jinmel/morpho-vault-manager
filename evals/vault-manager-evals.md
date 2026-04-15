# Vault Manager Eval Matrix

## Scope

These evals define the minimum deterministic behavior expected from the repository and, later, the plugin implementation.

## Matrix

| ID | Scenario | Setup | Expected Result | Validation Path |
| --- | --- | --- | --- | --- |
| `CFG-001` | Fresh machine preflight passes | `openclaw`, `ows`, and Morpho CLI available | Configure preflight returns success | `scripts/check/evals --only=CFG-001` |
| `CFG-002` | Missing dependency fails loudly | Simulated missing binary via settings override | Preflight returns non-ok with actionable message | `scripts/check/evals --only=CFG-002` |
| `WAL-001` | Wallet create command is deterministic and secret-free | Build wallet create + api key commands | Commands reference wallet name and policy, no inline secrets | `scripts/check/evals --only=WAL-001` |
| `POL-001` | Provision API token only | Wallet exists | Agent credential is API token, not owner credential | future `configure` flow + logs |
| `POL-002` | Chain restriction enforced | Prepared transaction targets non-Base chain | Generated executable policy denies with chain reason | `scripts/check/evals --only=POL-002` |
| `POL-003` | Spender restriction enforced | Prepared approval targets unapproved spender | Generated executable policy denies with spender reason | `scripts/check/evals --only=POL-003` |
| `CRN-001` | Cron environment is ready | OpenClaw gateway reachable | `openclawGatewayIsReachable` returns true | `scripts/check/evals --only=CRN-001` |
| `CRN-002` | Cron environment warns when gateway is absent | Simulated missing openclaw binary | `openclawGatewayIsReachable` returns false without throwing | `scripts/check/evals --only=CRN-002` |
| `REB-001` | Dry-run no-op with zero balance | Wallet funded with nothing and no positions | Rebalance returns no-op summary | `scripts/check/evals --only=REB-001` |
| `REB-002` | Dry-run no-op below drift threshold | Wallet already matches target allocation | Rebalance returns no-op summary with drift reason | `scripts/check/evals --only=REB-002` |
| `REB-003` | Dry-run produces transaction plan | Wallet has drift above threshold | Returns prepared transactions plus simulation summary | `scripts/check/evals --only=REB-003` |
| `REB-004` | Simulation failure blocks execution | Morpho simulation returns failure | Rebalance status is blocked with a failed operation | `scripts/check/evals --only=REB-004` |
| `REB-005` | Policy denial blocks execution | Prepared tx violates policy | Live execution is aborted | `scripts/rebalance/live-run` |
| `REB-006` | Live run requires explicit arming | Valid prepared tx but no arming flag | Script refuses to execute | `scripts/rebalance/live-run` |
| `REB-007` | Allowed live execution succeeds | Valid prepared tx, successful simulation, arming enabled | Transaction(s) signed through OWS, broadcast on Base, and receipts reported | `scripts/rebalance/live-run` |
| `OBS-001` | Run logging is auditable | Any dry-run or live-run | Each run emits a JSONL log containing run id, phase transitions, final outcome, and no unredacted secrets | `scripts/check/evals --only=OBS-001` |

## Promotion Rule

A capability is not complete until its relevant row in this matrix has:

- a real implementation path
- a reproducible setup
- a pass/fail outcome that does not depend on manual interpretation
