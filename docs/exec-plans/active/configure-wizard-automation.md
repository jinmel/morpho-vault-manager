# Configure Wizard Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `configure` wizard's manual OWS shell steps with a `src/lib/ows-bootstrap.ts` adapter so brand-new users finish onboarding with zero `ows ...` commands to run and zero outputs to paste, while preserving bring-your-own-wallet UX via `--wallet`.

**Architecture:** New adapter module owns every OWS subprocess (install, wallet create/list, key create) plus pure output parsers. A JSON marker file at `~/.openclaw/vault-manager/state/<profileId>.wallet.json` (0600) stores `{ walletRef, walletAddress, passphrase, mnemonic? }` so reconfigure is silent. Configure delegates to the adapter; teardown removes the marker. No test framework is added — parser and adapter tests run through the existing `src/bin/evals.ts` system-scenario runner.

**Tech Stack:** TypeScript 5.9, `@clack/prompts` 0.7, `commander` 14, Node 24 subprocess via `openclaw/plugin-sdk/process-runtime`, `viem` for address checksumming. No new runtime or dev dependencies.

**Reference:** `docs/openclaw-vault-manager-spec-configure-wizard-automation.md` (commit `0c4bf60`).

---

## File Structure

**New:**
- `src/lib/ows-bootstrap.ts` — adapter with `ensureOwsInstalled`, `resolveOrCreateWallet`, `provisionApiKey`, `writeTokenToOpenclawEnv`, and three pure parsers.

**Modified:**
- `src/lib/types.ts` — add `WalletMarker` type.
- `src/cli/register.ts` — add `--wallet <ref>` and `--wallet-passphrase-env <var>` options to `configure` and `reconfigure` commands.
- `src/cli/configure.ts` — delete `promptWallet`, `promptTokenSource`, the manual-command `p.note` blocks, and the token retry loop; replace with adapter calls. Add a single install confirm in `preflight()`.
- `src/cli/teardown.ts` — delete marker file alongside profile/workspace cleanup.
- `src/lib/run-logger.ts` — extend value-based redaction to cover `ows_key_...` tokens and `Created wallet ...` mnemonic echo.
- `src/bin/evals.ts` — add parser system scenarios (`OBS-BOOT-PARSER-*`) and five new bootstrap scenarios (`CFG-006` through `CFG-010`).
- `evals/vault-manager-evals.md` — append CFG-006..010.
- `SECURITY.md`, `ARCHITECTURE.md`, `docs/openclaw-vault-manager-spec.md`, `docs/release-qa-checklist.md` — text edits per spec "Doc Deltas" section.
- `state/progress.json` — new milestone entry.

**Unchanged:** `src/lib/ows.ts` (signing path), `morpho.ts`, `openclaw.ts`, `secrets.ts`, `profile.ts`, `rebalance.ts`, `template.ts`, `preflight.ts`.

---

## Task 1: Add `WalletMarker` type

**Files:**
- Modify: `src/lib/types.ts` (end of file)

- [ ] **Step 1: Add the type**

Append to `src/lib/types.ts`:

```ts
export type WalletMarker = {
  walletRef: string;
  walletAddress: `0x${string}`;
  passphrase: string;
  mnemonic?: string;
  source: "auto-created" | "operator-provided";
  canonicalName: string;
  createdAt: string;
};
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (the type is declared but not yet used, and unused exported types don't fail tsc).

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "Add WalletMarker type for configure wizard automation"
```

---

## Task 2: Scaffold `ows-bootstrap.ts` with injectable deps

**Files:**
- Create: `src/lib/ows-bootstrap.ts`

- [ ] **Step 1: Write the module skeleton**

Create `src/lib/ows-bootstrap.ts`:

```ts
import path from "node:path";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import { commandExists as defaultCommandExists, runCommand as defaultRunCommand } from "./shell.js";
import type { CommandResult } from "./shell.js";
import type { VaultManagerSettings, WalletMarker } from "./types.js";

export type OwsBootstrapDeps = {
  runCommand?: (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;
  commandExists?: (command: string) => Promise<boolean>;
  runShell?: (scriptArgs: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;
  generatePassphrase?: () => string;
  now?: () => Date;
};

function deps(input?: OwsBootstrapDeps) {
  return {
    runCommand: input?.runCommand ?? defaultRunCommand,
    commandExists: input?.commandExists ?? defaultCommandExists,
    runShell:
      input?.runShell ??
      ((scriptArgs, opts) => defaultRunCommand("sh", scriptArgs, opts)),
    generatePassphrase:
      input?.generatePassphrase ?? (() => randomBytes(32).toString("hex")),
    now: input?.now ?? (() => new Date())
  };
}

export function walletMarkerPath(settings: VaultManagerSettings, profileId: string): string {
  return path.join(settings.dataRoot, "state", `${profileId}.wallet.json`);
}

export function canonicalWalletName(profileId: string): string {
  return profileId === "default"
    ? "morpho-vault-manager"
    : `morpho-vault-manager-${profileId}`;
}

export async function readWalletMarker(
  settings: VaultManagerSettings,
  profileId: string
): Promise<WalletMarker | null> {
  try {
    const raw = await readFile(walletMarkerPath(settings, profileId), "utf8");
    return JSON.parse(raw) as WalletMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeWalletMarker(
  settings: VaultManagerSettings,
  profileId: string,
  marker: WalletMarker
): Promise<void> {
  const stateDir = path.dirname(walletMarkerPath(settings, profileId));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const filePath = walletMarkerPath(settings, profileId);
  await writeFile(filePath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function deleteWalletMarker(
  settings: VaultManagerSettings,
  profileId: string
): Promise<boolean> {
  try {
    await unlink(walletMarkerPath(settings, profileId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ows-bootstrap.ts
git commit -m "Scaffold ows-bootstrap module with marker file helpers"
```

---

## Task 3: Implement `parseOwsWalletCreateOutput`

**Files:**
- Modify: `src/lib/ows-bootstrap.ts`

- [ ] **Step 1: Add the parser**

Append to `src/lib/ows-bootstrap.ts`:

```ts
export type ParsedWalletCreate = {
  walletRef: string;
  walletAddress: `0x${string}`;
  mnemonic: string;
};

export function parseOwsWalletCreateOutput(
  stdout: string
): ParsedWalletCreate | { error: string } {
  const text = stdout.replace(/\r\n/g, "\n");

  const walletMatch = text.match(/Created wallet\s+([0-9a-fA-F-]{8,})/);
  if (!walletMatch) {
    return { error: "could not find 'Created wallet <uuid>' line" };
  }
  const walletRef = walletMatch[1];

  const evmMatch = text.match(/eip155:\d+\s+(0x[0-9a-fA-F]{40})\b/);
  if (!evmMatch) {
    return { error: "could not find eip155 address row" };
  }
  let walletAddress: `0x${string}`;
  try {
    walletAddress = getAddress(evmMatch[1]);
  } catch {
    return { error: `invalid EVM address: ${evmMatch[1]}` };
  }

  const mnemonicMatch = text.match(
    /(?:mnemonic|recovery phrase)[^\n]*\n+((?:[a-z]+\s+){11,23}[a-z]+)/i
  );
  const mnemonic = mnemonicMatch ? mnemonicMatch[1].trim().replace(/\s+/g, " ") : "";
  if (!mnemonic) {
    return { error: "could not find mnemonic block (did you pass --show-mnemonic?)" };
  }
  const wordCount = mnemonic.split(/\s+/).length;
  if (wordCount !== 12 && wordCount !== 24) {
    return { error: `mnemonic word count ${wordCount} is not 12 or 24` };
  }

  return { walletRef, walletAddress, mnemonic };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ows-bootstrap.ts
git commit -m "Add parseOwsWalletCreateOutput parser"
```

---

## Task 4: Test `parseOwsWalletCreateOutput` via evals

**Files:**
- Modify: `src/bin/evals.ts` — add three parser system scenarios

- [ ] **Step 1: Add import**

Add to the top imports in `src/bin/evals.ts` (one import, grown in Tasks 5 and 6):

```ts
import { parseOwsWalletCreateOutput } from "../lib/ows-bootstrap.js";
```

- [ ] **Step 2: Append parser scenarios to `SYSTEM_SCENARIOS` array**

Add inside `SYSTEM_SCENARIOS` (before the closing `]`):

```ts
{
  id: "OBS-BOOT-PARSER-001",
  description: "parseOwsWalletCreateOutput handles the happy path",
  async run() {
    const stdout = [
      "Created wallet 3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff",
      "  eip155:1     0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B    m/44'/60'/0'/0/0",
      "  eip155:8453  0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B    m/44'/60'/0'/0/0",
      "",
      "Recovery phrase (write this down):",
      "abandon ability able about above absent absorb abstract absurd abuse access accident",
      ""
    ].join("\n");
    const parsed = parseOwsWalletCreateOutput(stdout);
    if ("error" in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);
    assertEqual("walletRef", parsed.walletRef, "3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff");
    assertEqual(
      "walletAddress",
      parsed.walletAddress,
      "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"
    );
    assertEqual("mnemonic word count", parsed.mnemonic.split(/\s+/).length, 12);
  }
},
{
  id: "OBS-BOOT-PARSER-002",
  description: "parseOwsWalletCreateOutput rejects missing mnemonic",
  async run() {
    const stdout = [
      "Created wallet 3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff",
      "  eip155:1     0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"
    ].join("\n");
    const parsed = parseOwsWalletCreateOutput(stdout);
    assertTrue("returned error", "error" in parsed);
  }
},
{
  id: "OBS-BOOT-PARSER-003",
  description: "parseOwsWalletCreateOutput rejects missing wallet id",
  async run() {
    const parsed = parseOwsWalletCreateOutput("nothing to parse");
    assertTrue("returned error", "error" in parsed);
  }
},
```

- [ ] **Step 3: Run evals for the new scenarios**

Run: `npx tsx src/bin/evals.ts --only=OBS-BOOT-PARSER-001`
Then: `npx tsx src/bin/evals.ts --only=OBS-BOOT-PARSER-002`
Then: `npx tsx src/bin/evals.ts --only=OBS-BOOT-PARSER-003`
Expected: each prints `pass`.

- [ ] **Step 4: Commit**

```bash
git add src/bin/evals.ts
git commit -m "Add parser evals for parseOwsWalletCreateOutput"
```

---

## Task 5: Implement + test `parseOwsWalletList`

**Files:**
- Modify: `src/lib/ows-bootstrap.ts`, `src/bin/evals.ts`

- [ ] **Step 1: Add the parser**

Append to `src/lib/ows-bootstrap.ts`:

```ts
export type ParsedWalletListEntry = {
  name: string;
  walletRef: string;
  evmAddress?: `0x${string}`;
};

export function parseOwsWalletList(stdout: string): ParsedWalletListEntry[] {
  const text = stdout.replace(/\r\n/g, "\n");
  const entries: ParsedWalletListEntry[] = [];

  const blockRegex =
    /(^|\n)\s*([A-Za-z0-9][\w.-]*)\s+\(?([0-9a-fA-F-]{8,})\)?[^\n]*\n((?:\s+eip155:\d+\s+0x[0-9a-fA-F]{40}[^\n]*\n?)+)/g;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(text)) !== null) {
    const name = match[2];
    const walletRef = match[3];
    const addrMatch = match[4].match(/eip155:\d+\s+(0x[0-9a-fA-F]{40})/);
    let evmAddress: `0x${string}` | undefined;
    if (addrMatch) {
      try {
        evmAddress = getAddress(addrMatch[1]);
      } catch {
        evmAddress = undefined;
      }
    }
    entries.push({ name, walletRef, evmAddress });
  }

  if (entries.length === 0) {
    const lineRegex = /^\s*([A-Za-z0-9][\w.-]*)\s+([0-9a-fA-F-]{8,})\b/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRegex.exec(text)) !== null) {
      entries.push({ name: lm[1], walletRef: lm[2] });
    }
  }

  return entries;
}
```

- [ ] **Step 2: Add the import in evals.ts**

Update the earlier import in `src/bin/evals.ts`:

```ts
import {
  parseOwsKeyCreateOutput,
  parseOwsWalletCreateOutput,
  parseOwsWalletList
} from "../lib/ows-bootstrap.js";
```

(If `parseOwsKeyCreateOutput` isn't yet added, drop it from this import until Task 6.)

- [ ] **Step 3: Append parser scenario**

Append to `SYSTEM_SCENARIOS`:

```ts
{
  id: "OBS-BOOT-PARSER-004",
  description: "parseOwsWalletList extracts names and wallet refs",
  async run() {
    const stdout = [
      "morpho-vault-manager  3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff",
      "  eip155:1     0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
      "  eip155:8453  0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
      "",
      "other-wallet  01234567-89ab-cdef-0123-456789abcdef",
      "  eip155:1     0x0000000000000000000000000000000000000001"
    ].join("\n");
    const wallets = parseOwsWalletList(stdout);
    assertEqual("count", wallets.length, 2);
    assertEqual("first name", wallets[0].name, "morpho-vault-manager");
    assertEqual("first ref", wallets[0].walletRef, "3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff");
  }
},
{
  id: "OBS-BOOT-PARSER-005",
  description: "parseOwsWalletList handles empty output",
  async run() {
    assertEqual("empty", parseOwsWalletList("").length, 0);
  }
},
```

- [ ] **Step 4: Run evals**

Run: `npx tsx src/bin/evals.ts --only=OBS-BOOT-PARSER-004`
Run: `npx tsx src/bin/evals.ts --only=OBS-BOOT-PARSER-005`
Expected: `pass`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ows-bootstrap.ts src/bin/evals.ts
git commit -m "Add parseOwsWalletList parser and evals"
```

---

## Task 6: Implement + test `parseOwsKeyCreateOutput`

**Files:**
- Modify: `src/lib/ows-bootstrap.ts`, `src/bin/evals.ts`

- [ ] **Step 1: Add the parser**

Append to `src/lib/ows-bootstrap.ts`:

```ts
export type ParsedKeyCreate = { token: string };

export function parseOwsKeyCreateOutput(
  stdout: string
): ParsedKeyCreate | { error: string } {
  const match = stdout.match(/\bows_key_[A-Za-z0-9_-]{8,}/);
  if (!match) {
    return { error: "could not find 'ows_key_...' token in output" };
  }
  return { token: match[0] };
}
```

- [ ] **Step 2: Extend the import in evals.ts**

```ts
import {
  parseOwsKeyCreateOutput,
  parseOwsWalletCreateOutput,
  parseOwsWalletList
} from "../lib/ows-bootstrap.js";
```

- [ ] **Step 3: Append parser scenario**

```ts
{
  id: "OBS-BOOT-PARSER-006",
  description: "parseOwsKeyCreateOutput extracts the token",
  async run() {
    const parsed = parseOwsKeyCreateOutput(
      "Created API key claude-agent (id: abcd-1234)\nToken: ows_key_a1b2c3d4e5f6\n"
    );
    if ("error" in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);
    assertEqual("token", parsed.token, "ows_key_a1b2c3d4e5f6");
  }
},
{
  id: "OBS-BOOT-PARSER-007",
  description: "parseOwsKeyCreateOutput rejects missing token",
  async run() {
    const parsed = parseOwsKeyCreateOutput("no token here");
    assertTrue("returned error", "error" in parsed);
  }
},
```

- [ ] **Step 4: Run evals**

Run: `npx tsx src/bin/evals.ts --only=OBS-BOOT-PARSER-006`
Run: `npx tsx src/bin/evals.ts --only=OBS-BOOT-PARSER-007`
Expected: `pass`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ows-bootstrap.ts src/bin/evals.ts
git commit -m "Add parseOwsKeyCreateOutput parser and evals"
```

---

## Task 7: Implement `ensureOwsInstalled`

**Files:**
- Modify: `src/lib/ows-bootstrap.ts`

- [ ] **Step 1: Add the function**

Append to `src/lib/ows-bootstrap.ts`:

```ts
export type EnsureOwsResult = {
  status: "preexisting" | "just-installed" | "declined" | "failed" | "path-stale";
  stderr?: string;
  hint?: string;
};

export async function ensureOwsInstalled(
  settings: VaultManagerSettings,
  opts: { confirmInstall: () => Promise<boolean> },
  input?: OwsBootstrapDeps
): Promise<EnsureOwsResult> {
  const d = deps(input);

  if (await d.commandExists(settings.owsCommand)) {
    return { status: "preexisting" };
  }

  const confirmed = await opts.confirmInstall();
  if (!confirmed) {
    return { status: "declined" };
  }

  const install = await d.runShell(
    ["-lc", "curl -fsSL https://docs.openwallet.sh/install.sh | bash"],
    { env: process.env }
  );
  if (install.code !== 0) {
    return { status: "failed", stderr: install.stderr || install.stdout };
  }

  if (await d.commandExists(settings.owsCommand)) {
    return { status: "just-installed" };
  }

  return {
    status: "path-stale",
    hint: [
      "OWS installed but not yet on PATH.",
      "Likely path: ~/.ows/bin",
      "Run: exec $SHELL -l",
      "Then rerun: openclaw vault-manager configure"
    ].join("\n")
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ows-bootstrap.ts
git commit -m "Implement ensureOwsInstalled with injected runShell"
```

---

## Task 8: Implement `resolveOrCreateWallet` auto-create branch

**Files:**
- Modify: `src/lib/ows-bootstrap.ts`

- [ ] **Step 1: Add the function (auto-create + marker reuse)**

Append to `src/lib/ows-bootstrap.ts`:

```ts
export type WalletResolution = {
  walletRef: string;
  walletAddress: `0x${string}`;
  passphrase: string;
  source: "marker" | "override" | "auto-created";
  canonicalName: string;
};

export type ResolveWalletParams = {
  profileId: string;
  override?: { walletRef: string; passphrase: string };
};

export async function resolveOrCreateWallet(
  settings: VaultManagerSettings,
  params: ResolveWalletParams,
  input?: OwsBootstrapDeps
): Promise<WalletResolution> {
  const d = deps(input);

  const existingMarker = await readWalletMarker(settings, params.profileId);
  if (existingMarker) {
    return {
      walletRef: existingMarker.walletRef,
      walletAddress: existingMarker.walletAddress,
      passphrase: existingMarker.passphrase,
      source: "marker",
      canonicalName: existingMarker.canonicalName
    };
  }

  if (params.override) {
    const list = await d.runCommand(settings.owsCommand, ["wallet", "list"]);
    if (list.code !== 0) {
      throw new Error(`ows wallet list failed: ${list.stderr || list.stdout}`);
    }
    const wallets = parseOwsWalletList(list.stdout);
    const match = wallets.find(
      (w) =>
        w.name === params.override!.walletRef ||
        w.walletRef === params.override!.walletRef
    );
    if (!match) {
      throw new Error(
        `wallet '${params.override.walletRef}' not found in OWS. Run \`ows wallet list\` to see available wallets.`
      );
    }
    if (!match.evmAddress) {
      throw new Error(
        `wallet '${params.override.walletRef}' has no EVM address in \`ows wallet list\` output`
      );
    }
    return {
      walletRef: match.walletRef,
      walletAddress: match.evmAddress,
      passphrase: params.override.passphrase,
      source: "override",
      canonicalName: match.name
    };
  }

  const canonical = canonicalWalletName(params.profileId);
  const list = await d.runCommand(settings.owsCommand, ["wallet", "list"]);
  if (list.code !== 0) {
    throw new Error(`ows wallet list failed: ${list.stderr || list.stdout}`);
  }
  const existing = parseOwsWalletList(list.stdout);
  const collides = existing.some((w) => w.name === canonical);
  const nameToCreate = collides
    ? `${canonical}-${Math.floor(d.now().getTime() / 1000)}`
    : canonical;

  const passphrase = d.generatePassphrase();
  const create = await d.runCommand(
    settings.owsCommand,
    ["wallet", "create", "--name", nameToCreate, "--show-mnemonic"],
    { env: { ...process.env, OWS_PASSPHRASE: passphrase } }
  );
  if (create.code !== 0) {
    throw new Error(`ows wallet create failed: ${create.stderr || create.stdout}`);
  }

  const parsed = parseOwsWalletCreateOutput(create.stdout);
  if ("error" in parsed) {
    throw new Error(
      `ows wallet create succeeded but output could not be parsed: ${parsed.error}`
    );
  }

  const marker: WalletMarker = {
    walletRef: parsed.walletRef,
    walletAddress: parsed.walletAddress,
    passphrase,
    mnemonic: parsed.mnemonic,
    source: "auto-created",
    canonicalName: nameToCreate,
    createdAt: d.now().toISOString()
  };
  await writeWalletMarker(settings, params.profileId, marker);

  return {
    walletRef: marker.walletRef,
    walletAddress: marker.walletAddress,
    passphrase: marker.passphrase,
    source: "auto-created",
    canonicalName: marker.canonicalName
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ows-bootstrap.ts
git commit -m "Implement resolveOrCreateWallet with marker reuse, override, and auto-create paths"
```

---

## Task 9: Implement `provisionApiKey` and `writeTokenToOpenclawEnv`

**Files:**
- Modify: `src/lib/ows-bootstrap.ts`

- [ ] **Step 1: Add the functions**

Append to `src/lib/ows-bootstrap.ts`:

```ts
import { setEnvVar } from "./openclaw.js";

export type ProvisionApiKeyResult = {
  token: string;
};

export async function provisionApiKey(
  params: {
    settings: VaultManagerSettings;
    walletRef: string;
    keyName: string;
    passphrase: string;
  },
  input?: OwsBootstrapDeps
): Promise<ProvisionApiKeyResult> {
  const d = deps(input);
  const result = await d.runCommand(
    params.settings.owsCommand,
    ["key", "create", "--name", params.keyName, "--wallet", params.walletRef],
    { env: { ...process.env, OWS_PASSPHRASE: params.passphrase } }
  );

  if (result.code !== 0) {
    const stderr = (result.stderr || result.stdout).toLowerCase();
    if (stderr.includes("passphrase") || stderr.includes("unauthorized") || stderr.includes("decrypt")) {
      throw Object.assign(new Error("passphrase rejected by ows key create"), {
        code: "bad_passphrase"
      });
    }
    throw new Error(`ows key create failed: ${result.stderr || result.stdout}`);
  }

  const parsed = parseOwsKeyCreateOutput(result.stdout);
  if ("error" in parsed) {
    throw new Error(`ows key create succeeded but output could not be parsed: ${parsed.error}`);
  }
  return { token: parsed.token };
}

export async function writeTokenToOpenclawEnv(
  settings: VaultManagerSettings,
  envVar: string,
  token: string
): Promise<void> {
  const envResult = await setEnvVar(settings, envVar, token);
  if (!envResult.ok) {
    throw new Error(
      `Failed to set env.vars.${envVar} in openclaw config: ${envResult.stderr || "unknown error"}`
    );
  }
}
```

- [ ] **Step 2: Move the `setEnvVar` import to the top of the file**

Remove the inline `import { setEnvVar } from "./openclaw.js";` you appended in Step 1, and instead add that import near the top of `src/lib/ows-bootstrap.ts`, alongside the existing `./shell.js` and `./types.js` imports. Result:

```ts
import { commandExists as defaultCommandExists, runCommand as defaultRunCommand } from "./shell.js";
import type { CommandResult } from "./shell.js";
import { setEnvVar } from "./openclaw.js";
import type { VaultManagerSettings, WalletMarker } from "./types.js";
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ows-bootstrap.ts
git commit -m "Implement provisionApiKey and writeTokenToOpenclawEnv"
```

---

## Task 10: Wire `--wallet` and `--wallet-passphrase-env` CLI flags

**Files:**
- Modify: `src/cli/register.ts`

- [ ] **Step 1: Update the `configure` and `reconfigure` command options**

Edit `src/cli/register.ts` — replace the two relevant command blocks:

```ts
  vaultManager
    .command("configure")
    .description("Run the guided onboarding flow for a vault manager profile")
    .option("--profile <id>", "Profile id", "default")
    .option("--wallet <ref>", "Use this existing OWS wallet (name or UUID) instead of auto-creating")
    .option(
      "--wallet-passphrase-env <var>",
      "Env var name that holds the passphrase for --wallet (overrides the interactive prompt)"
    )
    .action(async (opts: { profile: string; wallet?: string; walletPassphraseEnv?: string }) => {
      logger?.info?.(`vault-manager: configure ${opts.profile}`);
      await runConfigureFlow({
        settings,
        logger,
        profileId: opts.profile,
        walletOverrideRef: opts.wallet,
        walletPassphraseEnvVar: opts.walletPassphraseEnv
      });
    });

  vaultManager
    .command("reconfigure")
    .description("Re-run configure for an existing profile")
    .option("--profile <id>", "Profile id", "default")
    .option("--wallet <ref>", "Use this existing OWS wallet (name or UUID) instead of auto-creating")
    .option(
      "--wallet-passphrase-env <var>",
      "Env var name that holds the passphrase for --wallet (overrides the interactive prompt)"
    )
    .action(async (opts: { profile: string; wallet?: string; walletPassphraseEnv?: string }) => {
      logger?.info?.(`vault-manager: reconfigure ${opts.profile}`);
      await runConfigureFlow({
        settings,
        logger,
        profileId: opts.profile,
        walletOverrideRef: opts.wallet,
        walletPassphraseEnvVar: opts.walletPassphraseEnv
      });
    });
```

- [ ] **Step 2: Extend the `ConfigureContext` / `runConfigureFlow` signature in configure.ts**

Open `src/cli/configure.ts` and update the local `ConfigureContext` type (currently at line ~38):

```ts
type ConfigureContext = {
  settings: VaultManagerSettings;
  logger?: CliLogger;
  profileId: string;
  walletOverrideRef?: string;
  walletPassphraseEnvVar?: string;
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (fields are optional and not yet read).

- [ ] **Step 4: Commit**

```bash
git add src/cli/register.ts src/cli/configure.ts
git commit -m "Add --wallet and --wallet-passphrase-env CLI flags"
```

---

## Task 11: Replace preflight OWS-install loop with `ensureOwsInstalled`

**Files:**
- Modify: `src/cli/configure.ts` (the `preflight()` function, roughly lines 355–438)

- [ ] **Step 1: Add the import**

Near the top of `src/cli/configure.ts`, add:

```ts
import { ensureOwsInstalled } from "../lib/ows-bootstrap.js";
```

- [ ] **Step 2: Replace the OWS-missing block inside `preflight()`**

Find the `if (owsIssue) { ... }` block (around line 367) and replace it with:

```ts
  if (owsIssue) {
    const install = await ensureOwsInstalled(settings, {
      confirmInstall: async () =>
        requiredBoolean(
          await p.confirm({
            message: "OWS is not installed. Install it now via the official installer?",
            initialValue: true
          }),
          "OWS install confirmation"
        )
    });

    if (install.status === "declined") {
      fail("Install OWS before running configure. See https://docs.openwallet.sh/");
    }
    if (install.status === "failed") {
      fail(`OWS install failed: ${install.stderr ?? "unknown error"}`);
    }
    if (install.status === "path-stale") {
      fail(install.hint ?? "OWS installed but not on PATH; restart your shell and rerun.");
    }
    // install.status is "preexisting" (race) or "just-installed"; fall through.
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/configure.ts
git commit -m "Replace preflight OWS-install prompt loop with ensureOwsInstalled"
```

---

## Task 12: Replace `promptWallet` with `resolveOrCreateWallet`

**Files:**
- Modify: `src/cli/configure.ts`

- [ ] **Step 1: Add the import**

Extend the `ows-bootstrap` import at the top:

```ts
import {
  ensureOwsInstalled,
  resolveOrCreateWallet
} from "../lib/ows-bootstrap.js";
```

- [ ] **Step 2: Delete the `promptWallet` function**

Remove the entire `async function promptWallet(...)` definition (roughly lines 440–548) from `src/cli/configure.ts`.

- [ ] **Step 3: Replace the call in `runConfigureFlow` + delete the backup confirm**

Locate inside `runConfigureFlow` (around line 810):

```ts
  const wallet = await promptWallet(settings, existing.profile ?? undefined);

  const backedUp = requiredBoolean(await p.confirm({
    message: "Have you backed up the wallet recovery material and confirmed you understand the owner credential must stay out of the agent?",
    initialValue: false
  }), "backup confirmation");

  if (!backedUp) {
    fail("Backup confirmation is required.");
  }
```

Replace it with:

```ts
  const override = await resolveOverrideParams(context);
  const resolution = await resolveOrCreateWallet(settings, {
    profileId,
    override
  });
  const wallet = {
    walletMode: resolution.source === "override" ? "existing" : "created",
    walletRef: resolution.walletRef,
    walletAddress: resolution.walletAddress
  } as const;
  await p.note(
    `Wallet ready: ${resolution.canonicalName} (${resolution.walletAddress}) [${resolution.source}]`,
    "Wallet"
  );
```

- [ ] **Step 4: Add the `resolveOverrideParams` helper above `runConfigureFlow`**

Insert above `export async function runConfigureFlow`:

```ts
async function resolveOverrideParams(
  context: ConfigureContext
): Promise<{ walletRef: string; passphrase: string } | undefined> {
  const walletRef =
    context.walletOverrideRef ??
    (process.env.OWS_VAULT_MANAGER_WALLET || undefined);
  if (!walletRef) return undefined;

  let passphrase: string | undefined;
  if (context.walletPassphraseEnvVar) {
    passphrase = process.env[context.walletPassphraseEnvVar];
    if (!passphrase) {
      fail(
        `--wallet-passphrase-env points at ${context.walletPassphraseEnvVar} but that env var is not set.`
      );
    }
  } else if (process.env.OWS_VAULT_MANAGER_WALLET_PASSPHRASE) {
    passphrase = process.env.OWS_VAULT_MANAGER_WALLET_PASSPHRASE;
  } else {
    const entered = await p.password({
      message: `Passphrase for wallet ${walletRef}`
    });
    if (p.isCancel(entered) || !entered) {
      fail("Wallet passphrase is required when --wallet is supplied.");
    }
    passphrase = entered as string;
  }

  return { walletRef, passphrase: passphrase! };
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/configure.ts
git commit -m "Replace promptWallet with resolveOrCreateWallet and passphrase prompt"
```

---

## Task 13: Replace `promptTokenSource` + API-key manual block with `provisionApiKey`

**Files:**
- Modify: `src/cli/configure.ts`

- [ ] **Step 1: Extend the import**

```ts
import {
  ensureOwsInstalled,
  provisionApiKey,
  resolveOrCreateWallet,
  writeTokenToOpenclawEnv
} from "../lib/ows-bootstrap.js";
```

- [ ] **Step 2: Delete `promptTokenSource`**

Remove the entire `async function promptTokenSource(...)` (around lines 550–627).

- [ ] **Step 3: Replace the token-source and API-key note block inside `runConfigureFlow`**

Find the block that starts with:

```ts
  const defaultTokenEnvVar = tokenEnvVarForProfile(settings, profileId);
  const defaultTokenSourceForProfile: TokenSource = ...
  const tokenSource = await promptTokenSource(...);
  const tokenEnvVar = ...;
```

and continues through the `await p.note([..."Manual step 2/2..."], "OWS API Key")` block and the `while (true) { const probe = await resolveApiToken(tokenSource); ... }` loop (roughly lines 873–960).

Replace that entire region with:

```ts
  const tokenEnvVar = tokenEnvVarForProfile(settings, profileId);
  const tokenSource: TokenSource = { kind: "env", envVar: tokenEnvVar };

  const agentId = agentIdForProfile(settings, profileId);
  const workspaceDir = workspaceDirForAgent(settings, agentId);

  const cronEnabled = requiredBoolean(await p.confirm({
    message: "Enable the cron job immediately?",
    initialValue: existing.profile?.cronEnabled ?? false
  }), "cron enable confirmation");

  const provisionSpinner = p.spinner();
  provisionSpinner.start("Provisioning OWS API key...");
  let apiKeyAttempts = 0;
  let apiResult: { token: string } | undefined;
  let resolutionPassphrase = resolution.passphrase;
  while (!apiResult) {
    try {
      apiResult = await provisionApiKey({
        settings,
        walletRef: resolution.walletRef,
        keyName: `${agentId}-agent`,
        passphrase: resolutionPassphrase
      });
    } catch (error) {
      if (
        (error as { code?: string }).code === "bad_passphrase" &&
        resolution.source === "override" &&
        apiKeyAttempts === 0
      ) {
        provisionSpinner.stop("Passphrase was rejected by OWS.");
        apiKeyAttempts += 1;
        const entered = await p.password({
          message: `Retry passphrase for wallet ${resolution.walletRef}`
        });
        if (p.isCancel(entered) || !entered) {
          fail("Wallet passphrase retry cancelled.");
        }
        resolutionPassphrase = entered as string;
        provisionSpinner.start("Provisioning OWS API key...");
        continue;
      }
      provisionSpinner.stop("OWS API key provisioning failed.");
      fail(`OWS API key provisioning failed: ${(error as Error).message}`);
    }
  }
  provisionSpinner.stop("OWS API key provisioned.");

  await writeTokenToOpenclawEnv(settings, tokenEnvVar, apiResult.token);

  await p.note(
    `Token written to openclaw.json env.vars.${tokenEnvVar} (rotated on every configure run).`,
    "Token Wired"
  );
```

- [ ] **Step 4: Clean up dangling references in `runConfigureFlow`'s final summary note**

Find the `"Configured"` `p.note` call near the end of `runConfigureFlow`. It currently renders a line like:

```ts
`Token source: ${tokenSourceDescription}`,
```

Replace that single line with:

```ts
`Token source: env:${tokenEnvVar}`,
```

Then remove any remaining references to `tokenSourceDescription`, `tokenProvisioningHint`, and `buildApiKeyCreateCommand` from inside `runConfigureFlow` (use your editor's search). `showStatus` still needs `describeTokenSource` — leave that function untouched.

- [ ] **Step 5: Remove unused imports**

After Step 4, run `npm run typecheck`. If tsc reports unused imports from `../lib/ows.js` (e.g. `buildApiKeyCreateCommand`, `buildWalletCreateCommand`), remove them from the `import ... from "../lib/ows.js"` line in `src/cli/configure.ts`. (The signing-path `ows.ts` continues to export them for other callers; they're just no longer needed in `configure.ts`.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/configure.ts
git commit -m "Replace manual OWS API key provisioning with provisionApiKey adapter call"
```

---

## Task 14: Update teardown to remove the wallet marker file

**Files:**
- Modify: `src/cli/teardown.ts`

- [ ] **Step 1: Add the import**

At the top of `src/cli/teardown.ts`:

```ts
import { deleteWalletMarker, walletMarkerPath } from "../lib/ows-bootstrap.js";
```

- [ ] **Step 2: Extend `TeardownResult`**

Change:

```ts
type TeardownResult = {
  profileId: string;
  cronDeleted: boolean;
  agentDeleted: boolean;
  workspaceRemoved: boolean;
  logsRemoved: boolean;
  runsRemoved: boolean;
  profileRemoved: boolean;
  errors: string[];
};
```

to:

```ts
type TeardownResult = {
  profileId: string;
  cronDeleted: boolean;
  agentDeleted: boolean;
  workspaceRemoved: boolean;
  logsRemoved: boolean;
  runsRemoved: boolean;
  profileRemoved: boolean;
  markerRemoved: boolean;
  errors: string[];
};
```

Update the `result` initializer in `runTeardown` to include `markerRemoved: false`.

- [ ] **Step 3: Add the preview line and the deletion step**

Inside `runTeardown`, after the existing `items.push(\`Profile: ${profileId}.json\`);` line, add:

```ts
  const markerPath = walletMarkerPath(settings, profileId);
  items.push(`Marker: ${markerPath} (${await pathExists(markerPath) ? "exists" : "not found"})`);
```

Then, after the `result.profileRemoved = await deleteProfileFile(...)` line, add:

```ts
  try {
    result.markerRemoved = await deleteWalletMarker(settings, profileId);
  } catch (error) {
    result.errors.push(`Marker removal failed: ${(error as Error).message}`);
  }
```

In the summary block at the end of `runTeardown`, add to the `summary` array:

```ts
      `Marker: ${result.markerRemoved ? "removed" : "FAILED"}`
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/teardown.ts
git commit -m "Teardown: remove wallet marker file"
```

---

## Task 15: Extend run-logger redaction for OWS tokens and mnemonic echoes

**Files:**
- Modify: `src/lib/run-logger.ts`

- [ ] **Step 1: Add value-level redaction**

Replace the existing `redact` function (around lines 37–51) with:

```ts
const SENSITIVE_KEY_REGEX = /token|secret|passphrase|mnemonic|private[_-]?key|signature/i;
const OWS_KEY_VALUE_REGEX = /\bows_key_[A-Za-z0-9_-]{8,}/g;
const WALLET_CREATE_ECHO_REGEX = /Created wallet[\s\S]*?(?:\n\s*\n|$)/i;

function redactString(value: string): string {
  let next = value.replace(OWS_KEY_VALUE_REGEX, "ows_key_***");
  next = next.replace(WALLET_CREATE_ECHO_REGEX, "[redacted wallet create output]");
  return next;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        copy[key] = "[redacted]";
      } else {
        copy[key] = redact(inner);
      }
    }
    return copy;
  }
  return value;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/run-logger.ts
git commit -m "Redact ows_key_ tokens and wallet-create echoes in run logs"
```

---

## Task 16: Add CFG-006 eval — fresh-machine auto-create

**Files:**
- Modify: `src/bin/evals.ts`

- [ ] **Step 1a: Extend the ows-bootstrap import at the top of the file**

In `src/bin/evals.ts`, update the existing `../lib/ows-bootstrap.js` import line (added across Tasks 4-6) to also include `resolveOrCreateWallet` and `readWalletMarker`:

```ts
import {
  parseOwsKeyCreateOutput,
  parseOwsWalletCreateOutput,
  parseOwsWalletList,
  readWalletMarker,
  resolveOrCreateWallet
} from "../lib/ows-bootstrap.js";
```

- [ ] **Step 1b: Add fake-subprocess helpers and the wallet-create fixture**

Still in `src/bin/evals.ts`, add these declarations near the existing test helpers (e.g. right after `assertContainsReason`):

```ts
type FakeCall = { command: string; args: string[] };
type FakeResponder = (call: FakeCall) => { stdout: string; stderr: string; code: number };

function fakeOwsDeps(respond: FakeResponder, calls: FakeCall[]) {
  return {
    runCommand: async (command: string, args: string[]) => {
      calls.push({ command, args });
      return respond({ command, args });
    },
    commandExists: async () => true,
    runShell: async () => ({ stdout: "", stderr: "", code: 0 }),
    generatePassphrase: () => "testpass".padEnd(64, "0"),
    now: () => new Date("2026-04-17T00:00:00.000Z")
  };
}

const FIXTURE_WALLET_CREATE_STDOUT = [
  "Created wallet 3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff",
  "  eip155:1     0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B    m/44'/60'/0'/0/0",
  "  eip155:8453  0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B    m/44'/60'/0'/0/0",
  "",
  "Recovery phrase (write this down):",
  "abandon ability able about above absent absorb abstract absurd abuse access accident",
  ""
].join("\n");
```

- [ ] **Step 2: Add the scenario**

Append to `SYSTEM_SCENARIOS`:

```ts
{
  id: "CFG-006",
  description: "Zero-touch auto-create: empty OWS + no marker → wallet + marker written",
  async run() {
    const settings = makeTempSettings();
    const calls: FakeCall[] = [];
    const deps = fakeOwsDeps(({ args }) => {
      if (args[0] === "wallet" && args[1] === "list") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "wallet" && args[1] === "create") {
        return { stdout: FIXTURE_WALLET_CREATE_STDOUT, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unexpected", code: 1 };
    }, calls);

    const resolution = await resolveOrCreateWallet(
      settings,
      { profileId: "default" },
      deps
    );

    assertEqual("source", resolution.source, "auto-created");
    assertEqual(
      "wallet address",
      resolution.walletAddress,
      "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"
    );
    assertEqual("canonical name", resolution.canonicalName, "morpho-vault-manager");

    const marker = await readWalletMarker(settings, "default");
    if (!marker) throw new Error("marker file was not written");
    assertEqual("marker source", marker.source, "auto-created");
    if (!marker.mnemonic) throw new Error("marker did not capture the mnemonic");

    assertEqual("call count", calls.length, 2);
    assertEqual("first call", calls[0].args.slice(0, 2).join(" "), "wallet list");
    assertEqual("second call", calls[1].args.slice(0, 2).join(" "), "wallet create");
  }
},
```

- [ ] **Step 3: Run the scenario**

Run: `npx tsx src/bin/evals.ts --only=CFG-006`
Expected: `pass`.

- [ ] **Step 4: Commit**

```bash
git add src/bin/evals.ts
git commit -m "Add CFG-006 eval: zero-touch wallet auto-create"
```

---

## Task 17: Add CFG-007 eval — marker reuse

**Files:**
- Modify: `src/bin/evals.ts`

- [ ] **Step 1: Extend the ows-bootstrap import to add `writeWalletMarker`**

```ts
import {
  parseOwsKeyCreateOutput,
  parseOwsWalletCreateOutput,
  parseOwsWalletList,
  readWalletMarker,
  resolveOrCreateWallet,
  writeWalletMarker
} from "../lib/ows-bootstrap.js";
```

- [ ] **Step 2: Append scenario**

```ts
{
  id: "CFG-007",
  description: "Marker reuse: existing marker short-circuits wallet list + create",
  async run() {
    const settings = makeTempSettings();
    const calls: FakeCall[] = [];
    const deps = fakeOwsDeps(() => ({ stdout: "", stderr: "unexpected call", code: 1 }), calls);

    await writeWalletMarker(settings, "default", {
      walletRef: "existing-uuid",
      walletAddress: "0x1111111111111111111111111111111111111111",
      passphrase: "stored-passphrase",
      source: "auto-created",
      canonicalName: "morpho-vault-manager",
      createdAt: "2026-04-01T00:00:00.000Z"
    });

    const resolution = await resolveOrCreateWallet(
      settings,
      { profileId: "default" },
      deps
    );

    assertEqual("source", resolution.source, "marker");
    assertEqual("walletRef", resolution.walletRef, "existing-uuid");
    assertEqual("passphrase", resolution.passphrase, "stored-passphrase");
    assertEqual("no ows calls", calls.length, 0);
  }
},
```

- [ ] **Step 3: Run the scenario**

Run: `npx tsx src/bin/evals.ts --only=CFG-007`
Expected: `pass`.

- [ ] **Step 4: Commit**

```bash
git add src/bin/evals.ts
git commit -m "Add CFG-007 eval: wallet marker reuse"
```

---

## Task 18: Add CFG-008 eval — operator override via `--wallet`

**Files:**
- Modify: `src/bin/evals.ts`

- [ ] **Step 1: Append scenario**

```ts
{
  id: "CFG-008",
  description: "Operator override: --wallet selects an existing wallet",
  async run() {
    const settings = makeTempSettings();
    const calls: FakeCall[] = [];
    // Use 0x1111... because it has no letters, so its EIP-55 checksum is identical
    // to the lowercase form — avoids depending on keccak output in test fixtures.
    const listStdout = [
      "my-wallet  01234567-89ab-cdef-0123-456789abcdef",
      "  eip155:1     0x1111111111111111111111111111111111111111",
      "  eip155:8453  0x1111111111111111111111111111111111111111"
    ].join("\n");
    const deps = fakeOwsDeps(({ args }) => {
      if (args[0] === "wallet" && args[1] === "list") {
        return { stdout: listStdout, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unexpected", code: 1 };
    }, calls);

    const resolution = await resolveOrCreateWallet(
      settings,
      {
        profileId: "default",
        override: { walletRef: "my-wallet", passphrase: "operator-pass" }
      },
      deps
    );

    assertEqual("source", resolution.source, "override");
    assertEqual(
      "wallet address",
      resolution.walletAddress,
      "0x1111111111111111111111111111111111111111"
    );
    assertEqual("canonical name", resolution.canonicalName, "my-wallet");
    assertEqual("passphrase threaded through", resolution.passphrase, "operator-pass");

    // Marker is NOT yet written for override path — wizard writes it after provisionApiKey succeeds.
    // resolveOrCreateWallet alone does not persist override resolutions.
    const marker = await readWalletMarker(settings, "default");
    assertEqual("marker not yet persisted", marker, null);
  }
},
```

- [ ] **Step 2: Run the scenario**

Run: `npx tsx src/bin/evals.ts --only=CFG-008`
Expected: `pass`.

- [ ] **Step 3: Commit**

```bash
git add src/bin/evals.ts
git commit -m "Add CFG-008 eval: operator override via --wallet"
```

**Note on marker persistence:** the spec says the marker is deferred in the override path until after `provisionApiKey` succeeds. That's a configure-flow concern (wizard writes the marker after calling `provisionApiKey`). `resolveOrCreateWallet` by itself only returns the resolution; for the override branch it does not persist. This task's assertion locks that contract in.

**Revisit task 8 if needed:** if Task 8's `resolveOrCreateWallet` wrote the marker in the override branch (re-read it now to confirm — it only writes in the auto-create branch), no code change needed. Otherwise remove the marker write from the override branch before re-running CFG-008.

---

## Task 19: Add CFG-009 eval — wrong passphrase via `provisionApiKey`

**Files:**
- Modify: `src/bin/evals.ts`

- [ ] **Step 1: Extend the ows-bootstrap import to add `provisionApiKey`**

```ts
import {
  parseOwsKeyCreateOutput,
  parseOwsWalletCreateOutput,
  parseOwsWalletList,
  provisionApiKey,
  readWalletMarker,
  resolveOrCreateWallet,
  writeWalletMarker
} from "../lib/ows-bootstrap.js";
```

- [ ] **Step 2: Append scenario**

```ts
{
  id: "CFG-009",
  description: "provisionApiKey surfaces bad-passphrase as error code bad_passphrase",
  async run() {
    const settings = makeTempSettings();
    const calls: FakeCall[] = [];
    const deps = fakeOwsDeps(() => ({
      stdout: "",
      stderr: "Error: failed to decrypt mnemonic: bad passphrase",
      code: 1
    }), calls);

    let captured: Error | undefined;
    try {
      await provisionApiKey(
        {
          settings,
          walletRef: "some-wallet",
          keyName: "test-agent",
          passphrase: "wrong"
        },
        deps
      );
    } catch (error) {
      captured = error as Error;
    }

    assertTrue("threw", Boolean(captured));
    assertEqual(
      "error code",
      (captured as Error & { code?: string }).code,
      "bad_passphrase"
    );
  }
},
```

- [ ] **Step 3: Run the scenario**

Run: `npx tsx src/bin/evals.ts --only=CFG-009`
Expected: `pass`.

- [ ] **Step 4: Commit**

```bash
git add src/bin/evals.ts
git commit -m "Add CFG-009 eval: provisionApiKey bad_passphrase error code"
```

---

## Task 20: Add CFG-010 eval — canonical name collision

**Files:**
- Modify: `src/bin/evals.ts`

- [ ] **Step 1: Append scenario**

```ts
{
  id: "CFG-010",
  description: "Canonical name collision: existing wallet with canonical name → suffixed create",
  async run() {
    const settings = makeTempSettings();
    const calls: FakeCall[] = [];
    const listStdout = [
      "morpho-vault-manager  deadbeef-dead-dead-dead-deadbeefdead",
      "  eip155:1     0x2222222222222222222222222222222222222222"
    ].join("\n");
    const deps = fakeOwsDeps(({ args }) => {
      if (args[0] === "wallet" && args[1] === "list") {
        return { stdout: listStdout, stderr: "", code: 0 };
      }
      if (args[0] === "wallet" && args[1] === "create") {
        return { stdout: FIXTURE_WALLET_CREATE_STDOUT, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unexpected", code: 1 };
    }, calls);

    const resolution = await resolveOrCreateWallet(
      settings,
      { profileId: "default" },
      deps
    );

    assertEqual("source", resolution.source, "auto-created");
    const createCall = calls.find((c) => c.args[0] === "wallet" && c.args[1] === "create");
    if (!createCall) throw new Error("expected a wallet create call");
    const nameFlag = createCall.args[createCall.args.indexOf("--name") + 1];
    assertTrue(
      "name is suffixed",
      nameFlag.startsWith("morpho-vault-manager-") && nameFlag !== "morpho-vault-manager",
      `got ${nameFlag}`
    );
  }
},
```

- [ ] **Step 2: Run the scenario**

Run: `npx tsx src/bin/evals.ts --only=CFG-010`
Expected: `pass`.

- [ ] **Step 3: Commit**

```bash
git add src/bin/evals.ts
git commit -m "Add CFG-010 eval: canonical name collision triggers suffixed wallet"
```

---

## Task 21: Update `evals/vault-manager-evals.md` with CFG-006..010

**Files:**
- Modify: `evals/vault-manager-evals.md`

- [ ] **Step 1: Open the file and append five bullet entries under the CFG section**

Find the existing CFG-001..005 block and append the five new rows in the same format as the existing rows (same table/list structure the file uses). Use these descriptions verbatim:

- `CFG-006` — Zero-touch auto-create: empty OWS + no marker → wallet + marker written.
- `CFG-007` — Marker reuse: existing marker short-circuits wallet list + create.
- `CFG-008` — Operator override via `--wallet` selects existing wallet and threads passphrase.
- `CFG-009` — `provisionApiKey` surfaces `bad_passphrase` error code on passphrase rejection.
- `CFG-010` — Canonical name collision: existing wallet with canonical name → suffixed create.

- [ ] **Step 2: Commit**

```bash
git add evals/vault-manager-evals.md
git commit -m "Document CFG-006..010 eval cases"
```

---

## Task 22: Run the full eval suite to confirm nothing regressed

**Files:** none modified.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run evals**

Run: `scripts/check/evals`
Expected: all scenarios pass, including CFG-001..010 and OBS-BOOT-PARSER-001..007.

- [ ] **Step 3: If any scenario fails**

Diagnose and fix. Do not proceed to the doc updates until the suite is clean.

---

## Task 23: Update SECURITY.md

**Files:**
- Modify: `SECURITY.md`

- [ ] **Step 1: Edit Credential Model → Owner Credential**

Replace the existing "Owner Credential" bullet list with:

```md
### Owner Credential

- Full wallet authority.
- Must never be used by the running vault-manager agent.
- For auto-created wallets, the plugin holds the wallet passphrase in `~/.openclaw/vault-manager/state/<profileId>.wallet.json` so configure/reconfigure can provision API keys non-interactively. The passphrase is owner-equivalent; protecting this file (mode 0600) is the operator's responsibility.
```

- [ ] **Step 2: Edit Credential Model → OWS API Token**

Replace the existing third bullet:

```md
- In v1, the raw token is provisioned out-of-process so the plugin never needs to load it into process memory
```

with:

```md
- The configure flow captures the token from `ows key create` stdout and forwards it to `openclaw config set env.vars.<var>`. The token transits plugin process memory during configure; it is not persisted to plugin files.
```

- [ ] **Step 3: Edit Storage Rules**

Append this bullet:

```md
- Wallet marker files may hold a wallet passphrase and mnemonic for auto-created wallets. They live at `~/.openclaw/vault-manager/state/<profileId>.wallet.json` with mode 0600 and are removed by `teardown`.
```

- [ ] **Step 4: Edit Logging Rules**

Append this bullet:

```md
- `ows wallet create --show-mnemonic` output must be redacted before display or logging. The bootstrap adapter captures stdout in memory and never echoes it.
```

- [ ] **Step 5: Commit**

```bash
git add SECURITY.md
git commit -m "SECURITY.md: document zero-touch wallet + API-key automation tradeoffs"
```

---

## Task 24: Update ARCHITECTURE.md

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Edit End-to-End Flow → Configure**

Find steps 3 and 4 (currently "Plugin creates or imports an OWS wallet." and the API-key-provisioning step) and replace with:

```md
3. Plugin auto-resolves or creates the OWS wallet (marker file → operator override via `--wallet` → zero-touch auto-create). Wallet passphrase is generated and stored locally for auto-created wallets; operator-provided wallets accept a one-time masked passphrase prompt or an env-supplied value.
4. Plugin auto-provisions the OWS API key and wires the token into the OpenClaw gateway env (`openclaw config set env.vars.<var>`).
```

- [ ] **Step 2: Edit Required Future Modules → OWS Adapter**

Append this bullet to the OWS Adapter list:

```md
- wallet bootstrap (resolve or create), passphrase-marker lifecycle, API-key provisioning and token routing
```

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "ARCHITECTURE.md: document configure wizard automation"
```

---

## Task 25: Update `docs/openclaw-vault-manager-spec.md`

**Files:**
- Modify: `docs/openclaw-vault-manager-spec.md`

- [ ] **Step 1: Edit Configure Flow Spec → Step 1. Wallet setup**

Replace the existing "Step 1. Wallet setup" section body with:

```md
### Step 1. Wallet setup

The plugin auto-resolves or creates the OWS wallet without asking the operator to run OWS commands. Resolution order:

1. If the profile has a marker file at `~/.openclaw/vault-manager/state/<profileId>.wallet.json`, reuse it.
2. If the operator passed `--wallet <ref>` (or set `OWS_VAULT_MANAGER_WALLET`), match that name/UUID against `ows wallet list` and accept a passphrase from `--wallet-passphrase-env`, `OWS_VAULT_MANAGER_WALLET_PASSPHRASE`, or an interactive masked prompt.
3. Otherwise, create a dedicated wallet (`morpho-vault-manager` or `morpho-vault-manager-<profileId>`) with a plugin-generated passphrase. Capture the mnemonic via `--show-mnemonic` and store everything in the marker file (mode 0600).

The wizard never asks the operator to copy `ows wallet create` commands or paste back public addresses.
```

- [ ] **Step 2: Edit Step 2. Agent-access provisioning**

Replace the section body with:

```md
### Step 2. Agent-access provisioning

The plugin runs `ows key create` itself — with the wallet passphrase from the marker file (or override) — and captures the resulting `ows_key_...` token from stdout. The token is written into `openclaw.json` via `openclaw config set env.vars.<var>`. The operator never pastes the token.

The key is scoped to exactly one wallet in v1. Policy attachment (`--policy`) is not used; runtime gates in the plugin enforce the Base/USDC/morpho-cli-prepared invariants before any transaction reaches OWS.
```

- [ ] **Step 3: Edit Security Model → Secret handling**

Replace the existing subsection with:

```md
### Secret handling

The wallet passphrase for auto-created wallets is generated by the plugin and stored at `~/.openclaw/vault-manager/state/<profileId>.wallet.json` (mode 0600). This is owner-equivalent material; protecting the file is the operator's responsibility.

The OWS API token transits plugin process memory during configure and lives in `openclaw.json` env.vars thereafter. It is rotated on every configure run. Mnemonic output from `ows wallet create --show-mnemonic` is captured directly into the marker file and never echoed to terminal or logs.
```

- [ ] **Step 4: Commit**

```bash
git add docs/openclaw-vault-manager-spec.md
git commit -m "Spec: document zero-touch wallet + API-key automation in Steps 1/2"
```

---

## Task 26: Update `docs/release-qa-checklist.md`

**Files:**
- Modify: `docs/release-qa-checklist.md`

- [ ] **Step 1: Append a new QA section at the end of the file**

```md
## Configure Wizard Automation

- [ ] Fresh machine without `ows` on PATH: install-confirm → auto-create wallet → configure completes without asking the operator to run any shell commands.
- [ ] Machine with a preexisting OWS wallet the operator wants to reuse: `--wallet <ref>` + passphrase prompt → configure completes and reuses the wallet. Marker file appears at `~/.openclaw/vault-manager/state/<profileId>.wallet.json` with mode 0600.
- [ ] Reconfigure the same profile: no wallet or token prompts fire beyond the kept decision list (risk, model, cron, delivery, funding check, validation run).
- [ ] Teardown removes the wallet marker file alongside profile/workspace/cron/agent cleanup.
```

- [ ] **Step 2: Commit**

```bash
git add docs/release-qa-checklist.md
git commit -m "release-qa: add configure-wizard-automation QA section"
```

---

## Task 27: Update `state/progress.json`

**Files:**
- Modify: `state/progress.json`

- [ ] **Step 1: Bump `lastUpdated` and append a milestone**

Change `lastUpdated` to today's date (2026-04-17) and append to the `milestones` array:

```json
{
  "id": "configure_wizard_automation",
  "status": "completed",
  "path": "docs/openclaw-vault-manager-spec-configure-wizard-automation.md",
  "notes": "configure wizard replaces manual OWS wallet + API-key steps with a src/lib/ows-bootstrap.ts adapter. Marker file at ~/.openclaw/vault-manager/state/<profileId>.wallet.json (0600) stores walletRef + passphrase (+ mnemonic for auto-created). --wallet flag preserves bring-your-own-wallet UX with masked passphrase prompt. CFG-006..010 evals cover auto-create, marker reuse, operator override, bad-passphrase, and name collision. SECURITY.md documents the credential-handling tradeoff."
}
```

(Set status to `in_progress` instead of `completed` until Tasks 22 and the QA checklist pass are actually done — the executing agent should flip it at the end.)

- [ ] **Step 2: Commit**

```bash
git add state/progress.json
git commit -m "progress: record configure_wizard_automation milestone"
```

---

## Final Verification

- [ ] **Run all checks**

```bash
npm run typecheck
scripts/check/evals
```

Expected: typecheck passes, all eval scenarios pass.

- [ ] **Manual QA**

Walk through the three scenarios from `docs/release-qa-checklist.md` → "Configure Wizard Automation" against a real OWS install (or a local test harness).

- [ ] **Move the plan to `completed/`**

```bash
mkdir -p docs/exec-plans/completed
git mv docs/exec-plans/active/configure-wizard-automation.md \
       docs/exec-plans/completed/configure-wizard-automation.md
git commit -m "exec-plan: mark configure-wizard-automation complete"
```
