import path from "node:path";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import { commandExists as defaultCommandExists, runCommand as defaultRunCommand } from "./shell.js";
import type { CommandResult } from "./shell.js";
import { setEnvVar } from "./openclaw.js";
import type { VaultManagerSettings, WalletMarker } from "./types.js";

export type OwsBootstrapDeps = {
  runCommand?: (
    command: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; input?: string }
  ) => Promise<CommandResult>;
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

export type MarkerReadResult =
  | { kind: "ok"; marker: WalletMarker }
  | { kind: "missing" }
  | { kind: "corrupt"; error: string };

export async function readWalletMarkerDetailed(
  settings: VaultManagerSettings,
  profileId: string
): Promise<MarkerReadResult> {
  let raw: string;
  try {
    raw = await readFile(walletMarkerPath(settings, profileId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "corrupt", error: (error as Error).message };
  }
  try {
    const parsed = JSON.parse(raw) as WalletMarker;
    if (!parsed || typeof parsed.walletRef !== "string" || typeof parsed.walletAddress !== "string") {
      return { kind: "corrupt", error: "marker JSON is missing required walletRef or walletAddress fields" };
    }
    return { kind: "ok", marker: parsed };
  } catch (error) {
    return { kind: "corrupt", error: (error as Error).message };
  }
}

export type WalletStatus =
  | { kind: "marker-healthy"; marker: WalletMarker }
  | { kind: "marker-stale"; marker: WalletMarker }
  | { kind: "marker-corrupt"; error: string; markerPath: string }
  | { kind: "no-marker-canonical-exists"; entry: ParsedWalletListEntry }
  | { kind: "no-marker-no-collision" };

export async function inspectWalletStatus(
  settings: VaultManagerSettings,
  profileId: string,
  input?: OwsBootstrapDeps
): Promise<WalletStatus> {
  const d = deps(input);
  const markerResult = await readWalletMarkerDetailed(settings, profileId);

  if (markerResult.kind === "corrupt") {
    return {
      kind: "marker-corrupt",
      error: markerResult.error,
      markerPath: walletMarkerPath(settings, profileId)
    };
  }

  const list = await d.runCommand(settings.owsCommand, ["wallet", "list"]);
  const wallets = list.code === 0 ? parseOwsWalletList(list.stdout) : [];

  if (markerResult.kind === "ok") {
    const ref = markerResult.marker.walletRef;
    const found = wallets.some((w) => w.walletRef === ref || w.name === ref);
    return found
      ? { kind: "marker-healthy", marker: markerResult.marker }
      : { kind: "marker-stale", marker: markerResult.marker };
  }

  const canonical = canonicalWalletName(profileId);
  const entry = wallets.find((w) => w.name === canonical && !!w.evmAddress);
  return entry
    ? { kind: "no-marker-canonical-exists", entry }
    : { kind: "no-marker-no-collision" };
}

export type ParsedWalletCreate = {
  walletRef: string;
  walletAddress: `0x${string}`;
  mnemonic: string;
};

export function parseOwsWalletCreateOutput(
  stdout: string
): ParsedWalletCreate | { error: string } {
  const text = stdout.replace(/\r\n/g, "\n");

  const walletMatch = text.match(/^\s*Wallet created:\s+([0-9a-fA-F-]{8,})\s*$/m);
  if (!walletMatch) {
    return { error: "could not find 'Wallet created: <uuid>' line" };
  }
  const walletRef = walletMatch[1];

  const evmMatch = text.match(/\beip155:\d+[^\n]*?(0x[0-9a-fA-F]{40})/);
  if (!evmMatch) {
    return { error: "could not find eip155 address row" };
  }
  let walletAddress: `0x${string}`;
  try {
    walletAddress = getAddress(evmMatch[1]);
  } catch {
    return { error: `invalid EVM address: ${evmMatch[1]}` };
  }

  const mnemonicLineMatch = text.match(
    /^(?:[a-z]+(?:\s+[a-z]+){11}|[a-z]+(?:\s+[a-z]+){23})\s*$/m
  );
  const mnemonic = mnemonicLineMatch ? mnemonicLineMatch[0].trim().replace(/\s+/g, " ") : "";
  if (!mnemonic) {
    return { error: "could not find mnemonic block (did you pass --show-mnemonic?)" };
  }

  return { walletRef, walletAddress, mnemonic };
}

export type ParsedWalletListEntry = {
  name: string;
  walletRef: string;
  evmAddress?: `0x${string}`;
};

export function parseOwsWalletList(stdout: string): ParsedWalletListEntry[] {
  const text = stdout.replace(/\r\n/g, "\n");
  const entries: ParsedWalletListEntry[] = [];

  const headerRegex = /^ID:\s+([0-9a-fA-F-]{8,})\s*$/gm;
  const headers: { start: number; walletRef: string }[] = [];
  let h: RegExpExecArray | null;
  while ((h = headerRegex.exec(text)) !== null) {
    headers.push({ start: h.index, walletRef: h[1] });
  }

  for (let i = 0; i < headers.length; i++) {
    const startIdx = headers[i].start;
    const endIdx = i + 1 < headers.length ? headers[i + 1].start : text.length;
    const block = text.slice(startIdx, endIdx);

    const nameMatch = block.match(/^Name:\s+(.+?)\s*$/m);
    if (!nameMatch) continue;

    const evmMatch = block.match(/\beip155:\d+[^\n]*?(0x[0-9a-fA-F]{40})/);
    let evmAddress: `0x${string}` | undefined;
    if (evmMatch) {
      try {
        evmAddress = getAddress(evmMatch[1]);
      } catch {
        evmAddress = undefined;
      }
    }

    entries.push({ name: nameMatch[1], walletRef: headers[i].walletRef, evmAddress });
  }

  return entries;
}

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

export type WalletResolution = {
  walletRef: string;
  walletAddress: `0x${string}`;
  passphrase: string;
  source: "marker" | "override" | "auto-created";
  canonicalName: string;
  nameCollided?: boolean;
  markerSource?: "auto-created" | "operator-provided";
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
      canonicalName: existingMarker.canonicalName,
      markerSource: existingMarker.source
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
    canonicalName: marker.canonicalName,
    nameCollided: collides
  };
}

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
    { input: `${params.passphrase}\n` }
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
