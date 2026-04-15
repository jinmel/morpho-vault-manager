import { runMorphoHealthCheck } from "./morpho.js";
import { openclawGatewayIsReachable } from "./openclaw.js";
import { commandExists } from "./shell.js";
import type { VaultManagerSettings } from "./types.js";

export type PreflightIssue = {
  code:
    | "missing_openclaw"
    | "missing_ows"
    | "missing_morpho_cli"
    | "morpho_health_check_failed"
    | "openclaw_gateway_unreachable";
  message: string;
  remediation?: string[];
};

export type PreflightResult = {
  ok: boolean;
  issues: PreflightIssue[];
  checked: {
    openclaw: boolean;
    ows: boolean;
    morphoCli: boolean;
    morphoHealthy: boolean;
    gatewayReachable: boolean;
  };
};

export async function runPreflightChecks(
  settings: VaultManagerSettings
): Promise<PreflightResult> {
  const [openclawPresent, owsPresent, morphoCliPresent] = await Promise.all([
    commandExists(settings.openclawCommand),
    commandExists(settings.owsCommand),
    commandExists(settings.morphoCliCommand)
  ]);

  const issues: PreflightIssue[] = [];

  if (!openclawPresent) {
    issues.push({
      code: "missing_openclaw",
      message: `Missing required command: ${settings.openclawCommand}`
    });
  }
  if (!owsPresent) {
    issues.push({
      code: "missing_ows",
      message: `Missing required command: ${settings.owsCommand}`
    });
  }
  if (!morphoCliPresent) {
    issues.push({
      code: "missing_morpho_cli",
      message: `Missing required command: ${settings.morphoCliCommand}`
    });
  }

  let morphoHealthy = false;
  if (morphoCliPresent) {
    morphoHealthy = await runMorphoHealthCheck(settings);
    if (!morphoHealthy) {
      issues.push({
        code: "morpho_health_check_failed",
        message:
          "morpho-cli health-check failed. Fix the Morpho CLI before configuring the vault manager."
      });
    }
  }

  let gatewayReachable = false;
  if (openclawPresent) {
    gatewayReachable = await openclawGatewayIsReachable(settings);
    if (!gatewayReachable) {
      issues.push({
        code: "openclaw_gateway_unreachable",
        message:
          "OpenClaw gateway is not reachable. Cron runs inside the gateway daemon, so keep the daemon running and verify it with `openclaw gateway status` before enabling cron.",
        remediation: [
          "Start or daemonize the OpenClaw gateway.",
          "Verify the daemon with: openclaw gateway status",
          "Rerun configure after the gateway stays reachable."
        ]
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    checked: {
      openclaw: openclawPresent,
      ows: owsPresent,
      morphoCli: morphoCliPresent,
      morphoHealthy,
      gatewayReachable
    }
  };
}
