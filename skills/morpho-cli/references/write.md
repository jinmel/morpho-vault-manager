# Morpho Write Shapes

Verified against v2026.4 of `@morpho-org/cli`.

## `prepare-deposit` / `prepare-withdraw`

Real response shape (flat, no top-level `simulation`):

```json
{
  "operation": "deposit",
  "chain": "base",
  "summary": "Deposit 1 USDC into vault 0xbeefe94c…",
  "analysisContext": { "protocol": "morpho", "operation": "deposit", ... },
  "requirements": [
    { "type": "approval", "token": "0x...", "spender": "0x...", "amount": "1000000" }
  ],
  "transactions": [
    {
      "to": "0x...",
      "data": "0x...",
      "value": "0",
      "chainId": "8453",
      "description": "Approve 0x... to spend 1000000 of 0x..."
    },
    {
      "to": "0x...",
      "data": "0x...",
      "value": "0",
      "chainId": "8453",
      "description": "Deposit 1 USDC into vault"
    }
  ],
  "warnings": [],
  "preview": { "vault": { "sharesReceived": "963...", "positionAssets": "1000000" } }
}
```

Key points:

- There is **no** top-level `simulation` / `simulated` / `simulationOk` field.
- `chainId` is a decimal string like `"8453"`, not an EIP-155 URN.
- Simulation is a **separate** call (see below).

## `simulate-transactions`

Input requires a JSON array of transactions. Each transaction must include a
`description` field, otherwise the CLI rejects the request with
`VALIDATION_ERROR`.

Success response:

```json
{
  "chain": "base",
  "executionResults": [ { "transactionIndex": 0, "success": true, "gasUsed": "..." } ],
  "allSucceeded": true,
  "totalGasUsed": "...",
  "warnings": []
}
```

Failure response keeps the same shape but `executionResults[i].success` is
false, `allSucceeded` is false, and `warnings` carries entries with
`level: "error"`.

## Adapter workflow

The `src/lib/morpho.ts` adapter normalizes this into the repo's
`MorphoPreparedOperation` type by:

1. Running the `prepare-*` command.
2. Normalizing the transactions and warnings.
3. Calling `simulate-transactions` with the normalized transactions + the
   returned `analysisContext`.
4. Merging the simulation warnings with the prepare warnings.
5. Setting `simulationOk = simulation.allSucceeded && no error-level warnings`.

## Minimum checks before live execution

1. `prepared.simulationOk === true`
2. `prepared.warnings` has no `level: "error"` entries
3. OWS policy approves every target contract and method selector
4. Broadcast goes through the plugin's OWS sign + Base RPC broadcast wrapper,
   never through Morpho tooling directly

The live path is intentionally narrow:

- Base only
- USDC vault operations only
- Vault allowlist only
- OWS-gated signing
