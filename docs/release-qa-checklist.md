# Release QA Checklist

Use this checklist on the candidate package that will be published. The goal is to verify the actual user install and first-run path, not just repo-local development paths.

## Release Candidate

- [ ] The release environment is running OpenClaw gateway `2026.4.12` or newer.
- [ ] `npm run typecheck` passes on the release commit.
- [ ] `scripts/check/evals` passes on the release commit.
- [ ] `scripts/dev/doctor --format=json` reports `fail=0`.
- [ ] `scripts/check/publish` passes.
- [ ] `scripts/check/release-install` passes on OpenClaw gateway `2026.4.12` or newer.
- [ ] `npm pack --dry-run --json` shows `README.md`, `openclaw.plugin.json`, compiled runtime files under `dist/`, and vendored skills.
- [ ] `npm pack --dry-run --json` does not include `docs/`, `evals/`, `state/progress.json`, dev scripts, `.env`, or source-only TS runtime files.
- [ ] The published package name is `@morpho/openclaw-vault-manager`.
- [ ] The plugin id remains `morpho-vault-manager`.

## Install Verification

- [ ] Start from a fresh user environment with no local unpublished workspace shortcuts.
- [ ] `openclaw plugins install @morpho/openclaw-vault-manager` succeeds.
- [ ] `openclaw plugins enable morpho-vault-manager` succeeds.
- [ ] `openclaw gateway restart` succeeds.
- [ ] The plugin is visible in OpenClaw plugin state after restart.
- [ ] `openclaw vault-manager --help` shows `configure`, `reconfigure`, `status`, `run-now`, `dry-run`, `live-run`, `pause`, and `resume`.

## Configure Verification

- [ ] `openclaw vault-manager configure` starts without stack traces.
- [ ] Preflight fails loudly and clearly if `openclaw`, `ows`, or `bunx @morpho-org/cli` is unavailable.
- [ ] Wallet create flow prints an operator-run OWS command and does not expose secrets inline.
- [ ] Existing-wallet flow accepts a known wallet reference and valid Base address.
- [ ] The wizard requires a valid EVM address and rejects malformed addresses.
- [ ] Policy artifacts are written successfully for the selected profile.
- [ ] The API key step clearly instructs the operator to run `ows api-key create` in a separate shell.
- [ ] Token source capture works for env-backed secrets.
- [ ] Token source capture works for file-backed secrets in `singleValue` mode.
- [ ] Token source validation fails clearly when the configured env var or file is missing.
- [ ] Funding guidance shows the Base wallet address and explicitly says `USDC on Base`.
- [ ] Model selection persists into the generated agent configuration.
- [ ] The generated workspace contains `AGENTS.md` with Base-only, USDC-only, and OWS-only signing rules.
- [ ] The configure flow creates the dedicated agent successfully.
- [ ] The configure flow shows the chosen cron delivery target and defaults to `last` when no explicit target is pinned.
- [ ] The configure flow creates the cron job successfully.
- [ ] The final validation run completes as a dry run and persists its result.

## Post-Configure Verification

- [ ] Operate the installed plugin through `openclaw` itself, not repo-local scripts only.
- [ ] `openclaw vault-manager status` reports profile, workspace, cron, and token-source readiness.
- [ ] `openclaw vault-manager dry-run --json` succeeds for the configured profile.
- [ ] `openclaw vault-manager reconfigure` starts correctly and reuses the existing profile state.
- [ ] `openclaw vault-manager live-run` refuses execution without the explicit arming flag.
- [ ] `openclaw vault-manager live-run --allow-live` is exercised only in a safe release-validation environment when a real live-path test is intended.
- [ ] `openclaw vault-manager run-now` queues an isolated cron run successfully.
- [ ] `openclaw vault-manager pause` disables the cron job.
- [ ] `openclaw vault-manager resume` re-enables the cron job.
- [ ] `openclaw cron list` shows the expected job name, schedule, timezone, isolated session mode, and agent id.

## Safety Verification

- [ ] No owner credentials, mnemonics, raw private keys, or API token values are written to profile JSON, workspace files, or logs.
- [ ] Live execution refuses to run unless explicitly armed.
- [ ] A simulation failure produces an explicit blocked result.
- [ ] An OWS signing failure produces an explicit blocked result.
- [ ] The write path remains Base-only and USDC-only.
- [ ] JSONL run logs contain phase transitions and outcomes without unredacted secret material.

## Publish Surface

- [ ] `README.md` contains install, configure, verify, and scope guidance.
- [ ] Install commands are consistent everywhere they appear.
- [ ] The package does not depend on unpublished local files.
- [ ] Registry-facing metadata matches the actual shipped plugin id and package name.

## Signoff

- [ ] Fresh install path verified by a human from the packed artifact or published package.
- [ ] Configure flow verified by a human on a clean environment.
- [ ] Release-blocking issues from this checklist are either fixed or explicitly waived before publish.
