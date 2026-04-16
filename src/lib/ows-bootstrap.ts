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
