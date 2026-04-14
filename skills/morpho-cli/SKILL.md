---
name: morpho-cli
description: >
  Interact with the Morpho lending protocol using morpho-cli. Use this skill when the user asks to:
  query vault APYs, TVL, or allocation options; inspect Morpho positions for a wallet;
  prepare or simulate vault deposit/withdraw transactions on Base or Ethereum.
---

# morpho-cli

> Vendored from the Morpho skills distribution and kept intentionally narrow for this plugin.

Use `bunx @morpho-org/cli` to query protocol state and prepare unsigned transactions. Every command returns JSON to stdout.

## Scope For This Repository

- Prefer `--chain base`
- Prefer USDC vault operations
- Use read commands before every write decision
- Use prepare/simulate flows before any live execution
- Never sign or broadcast directly from Morpho tooling in this repo

## Read Workflow

```bash
bunx @morpho-org/cli query-vaults --chain base --asset-symbol USDC
bunx @morpho-org/cli get-vault --chain base --address 0x...
bunx @morpho-org/cli get-positions --chain base --user-address 0x...
```

## Write Workflow

```bash
bunx @morpho-org/cli prepare-deposit --chain base --vault-address 0x... --user-address 0x... --amount 1000
bunx @morpho-org/cli prepare-withdraw --chain base --vault-address 0x... --user-address 0x... --amount 250
```

Always inspect `simulation.allSucceeded` before a live execution path. If simulation fails, stop.

## References

- [Read schemas](references/read.md)
- [Write schemas](references/write.md)
