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
