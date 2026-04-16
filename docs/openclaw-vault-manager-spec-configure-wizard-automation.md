# Configure Wizard Automation Spec

Companion to `docs/openclaw-vault-manager-spec.md`. Written 2026-04-17.

## Summary

Replace the current `openclaw vault-manager configure` flow's manual OWS steps (install check, wallet create, API key create, token routing) with zero-touch automation. The operator answers only the decisions that require real input (risk profile, schedule, delivery, funding check). Every `ows ...` command, every paste-back loop, and every token-source selector is removed.

This is a scoped relaxation of the v1 credential-handling invariants in `SECURITY.md`. Runtime invariants (Base only, USDC only, morpho-cli-prepared calldata only, simulation-fail terminal) are untouched.

## Motivation

The current wizard prints OWS commands as text, asks the operator to run them in a second shell, and then asks for copy-pasted outputs (wallet address, API token). Operators report this as the most friction-heavy part of onboarding. Since the plugin owns the end-to-end flow, there is no reason the wizard cannot run those commands itself and capture their output.

The tradeoff is explicit: the plugin will hold an owner-equivalent wallet passphrase in a local file for auto-created wallets, and the raw API token will transit plugin process memory. The operator accepts this in exchange for a single-command configure.

## Goals

- A brand-new operator completes configure with zero OWS shell commands to run, zero outputs to paste, and zero decisions about token source paths.
- An operator who already has an OWS wallet they want to use can opt in with `--wallet <ref>` (+ a passphrase prompt) without losing the zero-touch default for everyone else.
- A returning operator (`reconfigure`) sees zero prompts beyond the decision list.
- The runtime security envelope stays unchanged: only `morpho-cli`-prepared transactions reach OWS signing.

## Non-Goals

- No rotation/recovery UX beyond the natural token rotation that happens on every configure.
- No migration automation for profiles created under the old manual flow. Those profiles continue to run; their next `reconfigure` either goes through the operator-override path (if the operator supplies the passphrase) or creates a fresh wallet.
- No auto-edit of shell rc files after OWS install.
- No rollback-on-failure cleanup of partially created OWS state.

## Scope Summary (Prompts)

**Kept (real decisions):**

- OWS install confirm (single Y/N)
- Risk profile
- Model selection (inherit vs pin)
- Cron schedule, timezone, delivery mode, delivery target, enable-immediately
- Funding check loop (check / skip / wait)
- Validation dry-run confirm
- Passphrase prompt, *conditional* on operator using `--wallet` without an env-backed passphrase

**Dropped (auto-resolved):**

- "Create vs existing wallet" select
- Wallet name entry
- "Paste public address"
- "Have you backed up recovery material?" confirm
- Token source (env vs file), secret file path, JSON field
- "Paste OWS API key" / "token not yet available, retry?" loop

## Architecture

### New module: `src/lib/ows-bootstrap.ts`

Adapter that owns every OWS subprocess needed during onboarding. Matches the existing adapter pattern (`ows.ts`, `morpho.ts`, `openclaw.ts`, `preflight.ts`).

```ts
export async function ensureOwsInstalled(
  settings: VaultManagerSettings,
  opts: { confirmInstall: () => Promise<boolean> }
): Promise<{ status: "preexisting" | "just-installed" | "declined" | "failed"; stderr?: string }>;

export async function resolveOrCreateWallet(
  settings: VaultManagerSettings,
  params: {
    profileId: string;
    existingMarker?: WalletMarker;
    override?: { walletRef: string; passphrase: string };
  }
): Promise<{ walletRef: string; walletAddress: `0x${string}`; source: "marker" | "override" | "auto-created" }>;

export async function provisionApiKey(params: {
  settings: VaultManagerSettings;
  walletRef: string;
  keyName: string;
  passphrase: string;
}): Promise<{ token: string }>;

export async function writeTokenToOpenclawEnv(
  settings: VaultManagerSettings,
  envVar: string,
  token: string
): Promise<void>;

// Pure parsers, exported for unit tests:
export function parseOwsWalletCreateOutput(stdout: string): { walletRef: string; walletAddress: string; mnemonic: string } | { error: string };
export function parseOwsWalletList(stdout: string): Array<{ name: string; walletRef: string; evmAddress?: string }>;
export function parseOwsKeyCreateOutput(stdout: string): { token: string } | { error: string };
```

Parsers are pure functions that never throw. On unexpected input they return an error discriminant; the adapter maps those to typed errors.

### New state file: `~/.openclaw/vault-manager/state/<profileId>.wallet.json`

Mode `0600`. Parent dir `~/.openclaw/vault-manager/state/` created with `0700`. Written by `ows-bootstrap`, read by `configure` / `reconfigure`, removed by `teardown`.

```json
{
  "walletRef": "3198bc9c-aaaa-...",
  "walletAddress": "0xAB16...",
  "passphrase": "a1b2c3d4...hex",
  "mnemonic": "word1 word2 ... word12",
  "source": "auto-created",
  "canonicalName": "morpho-vault-manager-default",
  "createdAt": "2026-04-17T12:34:56.000Z"
}
```

- `passphrase`: always present. Plugin-generated for auto-create, operator-provided for override.
- `mnemonic`: present only when `source === "auto-created"` (captured via `--show-mnemonic`). Omitted for operator-provided wallets.
- `source`: one of `"auto-created"`, `"operator-provided"`.

### Files modified

- `src/cli/configure.ts` — `promptWallet()` deleted. `promptTokenSource()` deleted. The manual-command notes and retry loops are replaced by adapter calls. Preflight gains a one-Y/N install confirm.
- `src/lib/preflight.ts` — stays diagnostic; install attempt lives in `configure.ts` via the adapter.
- `src/lib/run-logger.ts` — extend redaction list with `/\bows_key_[A-Za-z0-9_-]{8,}/g` and a narrow passphrase-adjacent pattern.

### Files unchanged

`morpho.ts`, `openclaw.ts`, `secrets.ts`, `profile.ts`, `ows.ts` (signing path), `rebalance.ts`, `template.ts`.

## Wizard Flow (Sequence)

```
openclaw vault-manager configure [--wallet <ref>] [--wallet-passphrase-env <VAR>]

intro

[preflight]
  openclaw, morpho-cli present → ok
  ows absent → single Y/N confirm → subprocess install → recheck PATH
  ows present but PATH not updated → print "exec $SHELL -l, then rerun"

[wallet]
  resolveOrCreateWallet per precedence (see below)
  never echoes mnemonic or passphrase

[risk profile] [model] [cron] — unchanged prompts

[api token]
  provisionApiKey using marker passphrase
  writeTokenToOpenclawEnv into env.vars.OWS_MORPHO_VAULT_MANAGER_TOKEN

[funding] — unchanged loop

[workspace + agent + skill + cron job] — unchanged

[validation dry-run] — unchanged

outro
```

### Wallet resolution precedence (first match wins)

1. **Marker file exists for this profile** — reuse `{ walletRef, walletAddress, passphrase }` silently.
2. **Operator override** — `--wallet <ref>` flag OR `OWS_VAULT_MANAGER_WALLET` env. Plugin runs `ows wallet list`, matches by name or UUID to capture `walletAddress`, fails fast if no match. Passphrase source, in order: `--wallet-passphrase-env <VAR>` → `OWS_VAULT_MANAGER_WALLET_PASSPHRASE` env → interactive masked prompt (`p.password`). Cancel aborts configure. The passphrase is held in memory but **not written to the marker file yet**; it is verified by the later `provisionApiKey` step (which calls `ows key create` for real). On bad-passphrase failure there, the wizard re-prompts once and retries provisioning; second failure aborts without persisting marker or token. Marker file is written only after `provisionApiKey` succeeds.
3. **Zero-touch auto-create** — run `ows wallet list`. If canonical name `morpho-vault-manager-{profileId}` is absent → generate 32-byte hex passphrase, run `ows wallet create --name <canonical> --show-mnemonic` with `OWS_PASSPHRASE=<passphrase>`, parse stdout, write marker immediately (the plugin just generated the passphrase, so it is guaranteed correct; persisting eagerly lets a later `provisionApiKey` failure be retried via `reconfigure` without re-creating the wallet). If canonical name is present (user wiped plugin state but kept OWS) → create with suffix `morpho-vault-manager-{profileId}-{unixTimestamp}` and emit a one-line note pointing at `--wallet` for reuse.

## OWS CLI Bridge

### `ensureOwsInstalled`

Runs after one Y/N confirm:

```sh
sh -c 'curl -fsSL https://docs.openwallet.sh/install.sh | bash'
```

Re-checks `commandExists("ows")` on completion. If the binary is installed but not on PATH, returns a non-fatal status that the wizard renders as "restart your shell and rerun" (prints the likely path `~/.ows/bin`).

### `resolveOrCreateWallet` (auto-create branch)

```
OWS_PASSPHRASE=<generatedPassphrase> \
  ows wallet create --name morpho-vault-manager-default --show-mnemonic
```

Parse stdout via `parseOwsWalletCreateOutput`:

- `Created wallet <uuid>` line → `walletRef`
- first `eip155:...` table row → `walletAddress` (all EVM chains share the secp256k1 address)
- mnemonic block → `mnemonic`

### `provisionApiKey`

```
OWS_PASSPHRASE=<walletPassphraseFromMarker> \
  ows key create --name <agentId>-agent --wallet <walletRef>
```

No `--policy` flag — plugin relies on OWS defaults. Matches current `SECURITY.md` stance on policies.

Parse stdout via `parseOwsKeyCreateOutput`, match `/\bows_key_[A-Za-z0-9_-]+/`. Return `{ token }`.

### `writeTokenToOpenclawEnv`

Calls existing `setEnvVar(settings, envVar, token)` in `openclaw.ts`. No new mechanism.

## Secret Storage & On-Disk Layout

| Artifact             | Location                                                               | Mode | Lifecycle                                           |
| -------------------- | ---------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| Wallet marker file   | `~/.openclaw/vault-manager/state/<profileId>.wallet.json`              | 0600 | Written on wallet resolve; removed by `teardown`.   |
| Profile file         | `~/.openclaw/vault-manager/<profileId>.json`                           | 0644 | Unchanged. Never holds passphrase or mnemonic.      |
| OWS API token        | `openclaw.json` env.vars.`OWS_MORPHO_VAULT_MANAGER_TOKEN[_<PROFILE>]`  | —    | Rotated on each configure. Per-profile suffix for non-default profiles (same rule as today's `tokenEnvVarForProfile`). |
| OWS wallet/vault     | `~/.ows/` (OWS-owned)                                                  | —    | Out of plugin scope.                                |

### Redaction

Extend `src/lib/run-logger.ts` with:

- `/\bows_key_[A-Za-z0-9_-]{8,}/g` → `ows_key_***`
- Narrow passphrase-adjacent pattern (hex 64 adjacent to a `passphrase` key) → `***`

The bootstrap adapter captures `ows wallet create --show-mnemonic` stdout in memory, parses it, writes the marker file, and never echoes the captured content to the terminal or to the JSONL run logger.

### Teardown

`teardown` gains one deletion step: `~/.openclaw/vault-manager/state/<profileId>.wallet.json`. Order preserves the existing accumulate-errors-then-report pattern.

## Failure Modes

### Install

- Installer fails mid-run → print stderr, one retry prompt, then fail with manual install URL.
- Installer succeeds but `ows` not on PATH → wizard prints the expected path and tells the user to restart their shell. Does not auto-edit rc files.
- User declines the Y/N → fail fast with manual install instructions.

### Wallet auto-create

- `ows wallet create` exits non-zero → capture stderr, abort. No retry (failed create may leave half-state).
- Create succeeded but parser missed fields → write raw stdout + stderr to `<stateDir>/<profileId>.wallet.create.stdout|stderr`, abort with pointer. Recovery: `ows wallet delete <name>` and rerun.
- Marker file write failed → wallet exists in OWS but plugin cannot remember it. Abort with recovery: `ows wallet delete <canonicalName> --confirm` + rerun.

### Wallet operator override

- `--wallet <ref>` not in `ows wallet list` → fail fast with "Run `ows wallet list`".
- Wrong passphrase → detected when `provisionApiKey` calls `ows key create`. Wizard re-prompts once and retries `ows key create`. Second failure aborts without writing the marker file or any token.

### API key provisioning

- `ows key create` fails → abort. No token written anywhere.
- Token captured but `openclaw config set` fails → one retry; on second failure print the token to stderr plus a one-line recovery command (`openclaw config set env.vars.<var> <token>`) and exit. Operator can revoke manually via `ows key revoke` if preferred.

### Idempotence

- Marker present → short-circuits OWS calls. API key is re-provisioned every configure run (fresh token each time). Old token stays valid until explicitly revoked. Matches current `reconfigure` token-rotation behavior.

## Doc Deltas

### `SECURITY.md`

- **Credential Model → Owner Credential** — rewrite to: "Owner credentials must never be used by the running agent. For auto-created wallets, the plugin holds the wallet passphrase in `~/.openclaw/vault-manager/state/<profileId>.wallet.json` so configure/reconfigure can provision API keys non-interactively. The passphrase is owner-equivalent; protecting this file is the operator's responsibility."
- **Credential Model → OWS API Token** — replace the "out-of-process so the plugin never needs to load it into process memory" sentence with: "The configure flow captures the token from `ows key create` stdout and forwards it to `openclaw config set env.vars.<var>`. The token transits plugin process memory during configure; it is not persisted to plugin files."
- **Storage Rules** — add: "Wallet marker files MAY hold a wallet passphrase and mnemonic for auto-created wallets. They live at `~/.openclaw/vault-manager/state/<profileId>.wallet.json` with mode 0600 and are removed by `teardown`."
- **Logging Rules** — add: "`ows wallet create --show-mnemonic` output MUST be redacted before display or logging. The bootstrap adapter captures stdout in memory and never echoes it."
- **Non-Negotiable Invariants** — leave runtime invariants unchanged. Only credential-handling invariants shift.

### `ARCHITECTURE.md`

- **End-to-End Flow → Configure** — replace steps 3 and 4 with: "3. Plugin auto-resolves or creates the OWS wallet (marker → operator override → zero-touch create). 4. Plugin auto-provisions the OWS API key and wires the token into the OpenClaw gateway env."
- **Required Future Modules → OWS Adapter** — add: "wallet bootstrap (resolve or create), passphrase-marker lifecycle, API-key provisioning and token routing".

### `docs/openclaw-vault-manager-spec.md`

- **Configure Flow Spec → Step 1. Wallet setup** — replace the manual create/import copy with the zero-touch resolution order.
- **Step 2. Agent-access provisioning** — replace "the operator runs the emitted OWS provisioning command in a separate shell" with "the plugin runs `ows key create` itself and captures the token".
- **Security Model → Secret handling** — mirror the `SECURITY.md` change.

## Testing

### Unit tests (new `src/lib/ows-bootstrap.test.ts`)

Exercise the three parsers against real-shaped output samples + malformed inputs: extra whitespace, Unicode box-drawing, 12- and 24-word mnemonics, truncated stdout, empty string, error messages, unexpected locale.

### Eval cases (append to `evals/vault-manager-evals.md`; exercised by `scripts/check/evals`)

- `CFG-006` — fresh-machine auto-create: marker absent, OWS empty → wallet + marker + API key + env var all materialize.
- `CFG-007` — marker reuse: marker present → no `ows wallet create`, no `ows wallet list`; key provisioning still runs and rotates the token.
- `CFG-008` — operator override with `--wallet` + passphrase env → wallet selected from list, marker written.
- `CFG-009` — operator override with wrong passphrase → fail-fast after one retry, no marker mutation.
- `CFG-010` — name collision: marker absent + canonical name already in OWS → suffixed wallet, emits "use --wallet to reuse" note.

All five use the fake-subprocess injection pattern already in use for `CFG-001..005` — the adapter takes a `runCommand` dependency so tests swap in scripted stdout/stderr/exit fixtures.

### Manual QA (append to `docs/release-qa-checklist.md`)

- Fresh machine without `ows`: install-confirm → auto-create → configure completes.
- Machine with preexisting OWS wallet: `--wallet <ref>` + passphrase prompt → configure completes and reuses it.
- Reconfigure: no prompts beyond the kept list.

## Deferred / Out of Scope

- Passphrase rotation UX. For now, rotation means: `ows wallet export` the mnemonic, `ows wallet delete`, rerun configure — documented, not automated.
- Profile migration from the old manual flow. Old profiles keep running via their existing env-backed token source; reconfigure uses the override path.
- Skip-api-key-rotation flag for configure (each rerun currently mints a fresh token).
- Auto-edit of shell rc files after OWS install.

## Acceptance Criteria

1. `openclaw vault-manager configure` on a fresh machine completes with zero OWS shell commands for the operator to run and zero paste-backs.
2. `openclaw vault-manager configure --wallet <ref>` reuses an existing OWS wallet after a single masked passphrase prompt (or zero prompts if passphrase is env-supplied).
3. `openclaw vault-manager reconfigure` for a profile created under this flow produces no wallet/token prompts at all.
4. Parsers handle malformed OWS stdout without throwing (covered by unit tests).
5. Mnemonic output from `ows wallet create --show-mnemonic` never appears in terminal output, run logs, or profile/marker file echo paths outside the marker itself.
6. Runtime security envelope unchanged: only `morpho-cli`-prepared calldata reaches OWS signing.
7. `teardown` removes the new marker file alongside the existing profile, workspace, agent, and cron cleanup.
8. `CFG-006..010` eval cases pass under `scripts/check/evals`.
