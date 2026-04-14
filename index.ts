import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerVaultManagerCli } from "./src/cli/register.js";
import { resolveVaultManagerSettings } from "./src/lib/settings.js";

export default definePluginEntry({
  id: "morpho-vault-manager",
  name: "Morpho Vault Manager",
  description: "Onboard and operate a constrained Morpho vault manager agent on OpenClaw.",
  register(api) {
    const settings = resolveVaultManagerSettings(api.pluginConfig);

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
