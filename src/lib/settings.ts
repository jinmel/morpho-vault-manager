import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { registerInlineToken, tokenSourceFromPluginConfig } from "./secrets.js";
import type { VaultManagerSettings } from "./types.js";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function resolveVaultManagerSettings(pluginConfig?: Record<string, unknown>): VaultManagerSettings {
  const stateDir = resolveStateDir();
  const dataRoot = path.join(stateDir, "vault-manager");
  const defaultProfilePath = path.join(dataRoot, "profiles", "default.json");
  const config = pluginConfig ?? {};

  const hostResolvedToken = stringValue(config.apiKeyValue);
  if (hostResolvedToken) {
    registerInlineToken("plugin-config:apiKey", hostResolvedToken);
  }

  return {
    dataRoot,
    workspaceRoot: stringValue(config.workspaceRoot) ?? stateDir,
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
    defaultTokenSource: tokenSourceFromPluginConfig(
      config.apiKey,
      stringValue(config.defaultTokenEnvVar) ?? "OWS_MORPHO_VAULT_MANAGER_TOKEN"
    ),
    baseAgentId: "vault-manager",
    baseCronName: "Morpho Vault Rebalance",
    dryRunByDefault: booleanValue(config.dryRunByDefault) ?? true
  };
}
