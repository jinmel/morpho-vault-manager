import { runMorphoHealthCheck } from "./morpho.js";
import { openclawGatewayIsReachable } from "./openclaw.js";
import { commandExists } from "./shell.js";
export async function runPreflightChecks(settings) {
    const [openclawPresent, owsPresent, morphoCliPresent] = await Promise.all([
        commandExists(settings.openclawCommand),
        commandExists(settings.owsCommand),
        commandExists(settings.morphoCliCommand)
    ]);
    const issues = [];
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
                message: "morpho-cli health-check failed. Fix the Morpho CLI before configuring the vault manager."
            });
        }
    }
    let gatewayReachable = false;
    if (openclawPresent) {
        gatewayReachable = await openclawGatewayIsReachable(settings);
        if (!gatewayReachable) {
            issues.push({
                code: "openclaw_gateway_unreachable",
                message: "OpenClaw gateway is not reachable. Cron runs inside the gateway process, so start the gateway before running configure."
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
