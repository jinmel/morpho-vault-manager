# Morpho Write Shapes

All `prepare-*` commands return:

- `operation.summary`
- `operation.transactions[]`
- `operation.warnings[]`
- `operation.preview`
- `simulation`

Minimum checks before live execution:

1. `simulation` exists
2. `simulation.allSucceeded === true`
3. warnings are reviewed
4. transactions are handed off to OWS, not signed directly by Morpho tooling

For this repository, the live path is intentionally narrow:

- Base only
- USDC vault operations only
- Vault allowlist only
- OWS policy must still approve the prepared transactions
