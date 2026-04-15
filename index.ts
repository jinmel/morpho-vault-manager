import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { registerVaultManagerCli } from "./src/cli/register.js";
import { registerInlineToken } from "./src/lib/secrets.js";
import { resolveVaultManagerSettings } from "./src/lib/settings.js";

export default definePluginEntry({
  id: "morpho-vault-manager",
  name: "Morpho Vault Manager",
  description: "Onboard and operate a constrained Morpho vault manager agent on OpenClaw.",
  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;

    try {
      const resolved = normalizeResolvedSecretInputString({
        value: pluginConfig.apiKey,
        refValue: pluginConfig.apiKeyValue,
        path: "plugins.entries.morpho-vault-manager.apiKey"
      });
      if (resolved) {
        registerInlineToken("plugin-config:apiKey", resolved);
        pluginConfig.apiKeyValue = resolved;
      }
    } catch (error) {
      api.logger?.warn?.(
        `morpho-vault-manager: unresolved SecretRef for apiKey — ${(error as Error).message}`
      );
    }

    const settings = resolveVaultManagerSettings(pluginConfig);

    api.registerCli(
      ({ program, logger }) => {
        registerVaultManagerCli({
          program,
          logger,
          settings
        });
      },
      {
        descriptors: [
          {
            name: "vault-manager",
            description: "Configure and operate the Morpho vault manager agent",
            hasSubcommands: true
          }
        ]
      }
    );
  }
});
