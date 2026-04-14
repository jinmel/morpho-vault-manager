# Vault Manager Eval Matrix

## Scope

These evals define the minimum deterministic behavior expected from the repository and, later, the plugin implementation.

## Matrix

| ID | Scenario | Setup | Expected Result | Validation Path |
| --- | --- | --- | --- | --- |
| `CFG-001` | Fresh machine preflight passes | `openclaw`, `ows`, and Morpho CLI available | Configure preflight returns success | `scripts/check/configure` |
| `CFG-002` | Missing dependency fails loudly | Remove one required binary from `PATH` | Preflight exits non-zero with actionable message | `scripts/check/configure` |
| `WAL-001` | Create dedicated wallet | Empty OWS state or isolated test state | New wallet descriptor created; no mnemonic logged | future `configure` flow |
| `POL-001` | Provision API token only | Wallet exists | Agent credential is API token, not owner credential | future `configure` flow + logs |
| `POL-002` | Chain restriction enforced | Prepared transaction targets non-Base chain | OWS policy denies execution | `scripts/check/policy` |
| `POL-003` | Spender restriction enforced | Prepared approval targets unapproved spender | OWS policy denies execution | `scripts/check/policy` |
| `CRN-001` | Cron environment is ready | Gateway running continuously | Cron readiness check passes | `scripts/check/cron` |
| `CRN-002` | Cron environment warns when gateway is absent | Gateway unavailable | Readiness check exits non-zero with daemon guidance | `scripts/check/cron` |
| `REB-001` | Dry-run no-op with zero balance | Wallet funded with nothing and no positions | Rebalance returns no-op summary | `scripts/rebalance/dry-run` |
| `REB-002` | Dry-run no-op below drift threshold | Wallet already matches target allocation | Rebalance returns no-op summary with drift reason | `scripts/rebalance/dry-run` |
| `REB-003` | Dry-run produces transaction plan | Wallet has drift above threshold | Returns prepared transactions plus simulation summary | `scripts/rebalance/dry-run` |
| `REB-004` | Simulation failure blocks execution | Morpho simulation returns failure | Live execution is aborted | `scripts/rebalance/live-run` |
| `REB-005` | Policy denial blocks execution | Prepared tx violates policy | Live execution is aborted | `scripts/rebalance/live-run` |
| `REB-006` | Live run requires explicit arming | Valid prepared tx but no arming flag | Script refuses to execute | `scripts/rebalance/live-run` |
| `REB-007` | Allowed live execution succeeds | Valid prepared tx, successful simulation, arming enabled | Transaction(s) signed through OWS, broadcast on Base, and receipts reported | `scripts/rebalance/live-run` |
| `OBS-001` | Run logging is auditable | Any dry-run or live-run | Logs include run id, phase, and final outcome without secrets | future structured logs |

## Promotion Rule

A capability is not complete until its relevant row in this matrix has:

- a real implementation path
- a reproducible setup
- a pass/fail outcome that does not depend on manual interpretation
