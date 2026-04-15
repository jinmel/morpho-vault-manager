# Morpho Vault Manager

Native OpenClaw plugin for onboarding and running a constrained Morpho vault manager agent on Base.

## Scope

- Base only
- USDC only
- Morpho vault management only
- All signing through OWS

## Prerequisites

- `openclaw` installed and the gateway running
- OpenClaw gateway `2026.4.12` or newer
- `ows` installed and on `PATH`
- `bunx @morpho-org/cli` available
- A Base RPC URL configured if you plan to exercise live broadcast verification

## Install

```bash
openclaw plugins install @morpho/openclaw-vault-manager
openclaw plugins enable morpho-vault-manager
openclaw gateway restart
```

## Configure

```bash
openclaw vault-manager configure
```

The configure flow will:

1. run preflight checks
2. guide wallet create/import through OWS
3. write policy artifacts
4. ask you to create the OWS API key in a separate shell
5. record the token source as an env var or file reference
6. generate the dedicated agent workspace and `AGENTS.md`
7. create the OpenClaw cron job
8. run a final dry-run validation

The plugin never stores owner credentials or raw private keys in repo files, prompts, or profile JSON.

## Verify

```bash
openclaw vault-manager status
openclaw vault-manager dry-run --json
openclaw vault-manager run-now
```

Release QA should include operating the installed plugin through `openclaw` directly, not just running repo-local checks.

For repository-level health checks before publishing:

```bash
scripts/dev/doctor --format=json
scripts/check/publish
scripts/check/release-install
```

## Release QA

Use [docs/release-qa-checklist.md](docs/release-qa-checklist.md) as the final pre-release verification sheet for publish, install, configure, cron, and safety checks.
`scripts/check/release-install` is the fail-closed release gate for packed-artifact install on a supported OpenClaw version.
