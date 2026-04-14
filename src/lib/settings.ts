import os from "node:os";
import path from "node:path";
import type { VaultManagerSettings } from "./types.js";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function resolveVaultManagerSettings(pluginConfig?: Record<string, unknown>): VaultManagerSettings {
  const homeDir = os.homedir();
  const dataRoot = path.join(homeDir, ".openclaw", "vault-manager");
  const defaultProfilePath = path.join(dataRoot, "profiles", "default.json");
  const config = pluginConfig ?? {};

  return {
    dataRoot,
    workspaceRoot: stringValue(config.workspaceRoot) ?? path.join(homeDir, ".openclaw"),
    defaultProfilePath: stringValue(config.profilePath) ?? defaultProfilePath,
    owsCommand: stringValue(config.owsCommand) ?? "ows",
    openclawCommand: stringValue(config.openclawCommand) ?? "openclaw",
    morphoCliCommand: stringValue(config.morphoCliCommand) ?? "bunx",
    morphoCliArgsPrefix:
      (stringValue(config.morphoCliCommand) ?? "bunx") === "bunx"
        ? ["--package", "@morpho-org/cli", "morpho"]
        : [],
    baseRpcUrl:
      stringValue(config.baseRpcUrl) ??
      stringValue(process.env.VAULT_MANAGER_BASE_RPC_URL) ??
      stringValue(process.env.BASE_RPC_URL),
    defaultChain: "base",
    defaultCron: stringValue(config.defaultCron) ?? "0 */6 * * *",
    defaultTimezone:
      stringValue(config.defaultTimezone) ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
    defaultTokenEnvVar: stringValue(config.defaultTokenEnvVar) ?? "OWS_MORPHO_VAULT_MANAGER_TOKEN",
    baseAgentId: "vault-manager",
    baseCronName: "Morpho Vault Rebalance",
    dryRunByDefault: booleanValue(config.dryRunByDefault) ?? true
  };
}
