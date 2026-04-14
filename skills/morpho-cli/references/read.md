# Morpho Read Shapes

Important fields used by this repo:

## `query-vaults`

- `vaults[].address`
- `vaults[].name`
- `vaults[].asset.symbol`
- `vaults[].apyPct`
- `vaults[].tvlUsd`
- `vaults[].feePct`
- `vaults[].version`

## `get-vault`

- `vault.address`
- `vault.asset.symbol`
- `vault.apyPct`
- `vault.tvlUsd`
- `vault.allocations[]`

## `get-positions`

- `positions[].vault.address`
- `positions[].suppliedAmount.value`
- `positions[].shares`

Treat token amounts carefully:

- USDC has 6 decimals
- CLI values under `*.value` are already human-readable decimal strings
