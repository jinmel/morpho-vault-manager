# Morpho Read Shapes

Actual `morpho-cli` JSON shapes verified against v2026.4 of `@morpho-org/cli`.
The adapter in `src/lib/morpho.ts` normalizes all of these to the types declared
in that file.

## `query-vaults`

```json
{
  "vaults": [
    {
      "address": "0x...",
      "name": "...",
      "chain": "base",
      "asset": { "address": "0x...", "symbol": "USDC", "decimals": 6, "chain": "base" },
      "apyPct": "3.92",
      "tvl": "327438994539",
      "tvlUsd": "327395.66",
      "feePct": "5"
    }
  ],
  "chain": "base",
  "pagination": { "total": 1036, "limit": 3, "skip": 0 }
}
```

Used fields: `vaults[].address`, `vaults[].name`, `vaults[].asset.symbol`, `vaults[].apyPct`, `vaults[].tvlUsd`, `vaults[].feePct`.

## `get-vault`

The CLI wraps the payload under a `vault` key:

```json
{
  "vault": {
    "address": "0x...",
    "name": "...",
    "asset": { "address": "0x...", "symbol": "USDC", "decimals": 6 },
    "apyPct": "0.76",
    "tvlUsd": "1102734.38",
    "feePct": "10",
    "allocations": [ ... ]
  }
}
```

The adapter unwraps `response.vault` before normalizing.

## `get-positions`

Empty case:

```json
{
  "positions": [],
  "chain": "base",
  "count": 0,
  "userAddress": "0x..."
}
```

Non-empty case is normalized by `normalizeVaultPosition` which tolerates the
legacy `{vault, suppliedAmount}` shape and the current `{vaultAddress,
supplyAssets, supplyAssetsUsd}` shape.

## `get-token-balance`

```json
{
  "chain": "base",
  "userAddress": "0x...",
  "asset": { "address": "0x...", "symbol": "USDC", "decimals": 6 },
  "balance": "25141.21",
  "erc20Allowances": { "morpho": "0", "bundler": "0", "permit2": "0" }
}
```

`balance` is a plain decimal string; the adapter lifts it to `{symbol, value}`.

## Decimals

- USDC: 6
- WETH / DAI: 18

CLI `balance` and `value` fields are human-readable decimal strings, not raw
token units.
