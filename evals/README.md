# Evals

This directory holds the acceptance matrix for the vault-manager plugin.

The near-term goal is deterministic scenario coverage, not benchmark scoring.

Use [vault-manager-evals.md](/Users/jinsuk/code/morpho-vault-manager/evals/vault-manager-evals.md) as the source of truth for:

- must-pass setup cases
- must-pass no-op cases
- must-pass execution cases
- must-fail safety cases

When a new capability is added, add:

1. the scenario
2. the setup assumptions
3. the expected result
4. the primary validation command or script
