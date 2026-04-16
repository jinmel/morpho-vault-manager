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
