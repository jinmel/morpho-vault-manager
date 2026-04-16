import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAddress, parseUnits, formatUnits } from "viem";
import { BASE_USDC_ADDRESS, RISK_PRESETS, USDC_DECIMALS } from "../lib/constants.js";
import {
  CRON_SCHEDULE_PRESETS,
  describeCronSchedule,
  formatRiskPresetConfig
} from "../cli/configure.js";
import { openclawGatewayIsReachable } from "../lib/openclaw.js";
import { buildApiKeyCreateCommand, buildWalletCreateCommand } from "../lib/ows.js";
import { runPreflightChecks } from "../lib/preflight.js";
import {
  describeTokenSource,
  registerInlineToken,
  resolveApiToken,
  tokenSourceFromPluginConfig
} from "../lib/secrets.js";
import type {
  MorphoPositionsResponse,
  MorphoTokenBalanceResponse,
  MorphoVaultDetail,
  MorphoVaultPosition
} from "../lib/morpho.js";
import { saveProfile } from "../lib/profile.js";
import {
  parseOwsKeyCreateOutput,
  parseOwsWalletCreateOutput,
  parseOwsWalletList,
  readWalletMarker,
  resolveOrCreateWallet,
  writeWalletMarker
} from "../lib/ows-bootstrap.js";
import {
  runPlan,
  type PlanReadDeps,
  type PlanResult
} from "../lib/rebalance.js";
import { renderAgentInstructions } from "../lib/template.js";
import type { RiskProfileId, VaultManagerProfile, VaultManagerSettings } from "../lib/types.js";

type VaultFixture = {
  address: string;
  name: string;
  apyPct: string;
  feePct: string;
  tvlUsd: string;
};

type PositionFixture = {
  vaultAddress: string;
  vaultName: string;
  suppliedUsdc: string;
};

type Scenario = {
  id: string;
  description: string;
  profile: {
    riskProfile: RiskProfileId;
    walletAddress?: string;
  };
  vaults: VaultFixture[];
  positions: PositionFixture[];
  idleUsdc: string;
  marketPositions?: Array<Record<string, unknown>>;
  depsFactory?: (scenario: Scenario) => PlanReadDeps;
  expect: (result: PlanResult) => void | Promise<void>;
};

const SCENARIO_WALLET = getAddress("0x1111111111111111111111111111111111111111");

const VAULT_A: VaultFixture = {
  address: getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  name: "USDC Vault A",
  apyPct: "0.06",
  feePct: "0.05",
  tvlUsd: "50000000"
};

const VAULT_B: VaultFixture = {
  address: getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  name: "USDC Vault B",
  apyPct: "0.045",
  feePct: "0.05",
  tvlUsd: "20000000"
};

const VAULT_C: VaultFixture = {
  address: getAddress("0xcccccccccccccccccccccccccccccccccccccccc"),
  name: "USDC Vault C",
  apyPct: "0.042",
  feePct: "0.04",
  tvlUsd: "12000000"
};

const VAULT_D: VaultFixture = {
  address: getAddress("0xdddddddddddddddddddddddddddddddddddddddd"),
  name: "USDC Vault D",
  apyPct: "0.031",
  feePct: "0.03",
  tvlUsd: "3500000"
};

function fixtureVault(vault: VaultFixture): MorphoVaultDetail {
  return {
    address: vault.address,
    chain: "base",
    name: vault.name,
    version: "v2",
    asset: {
      address: BASE_USDC_ADDRESS,
      symbol: "USDC"
    },
    apyPct: vault.apyPct,
    feePct: vault.feePct,
    tvl: {
      symbol: "USDC",
      value: vault.tvlUsd
    },
    tvlUsd: vault.tvlUsd
  };
}

function fixturePositions(
  walletAddress: string,
  positions: PositionFixture[],
  marketPositions: Array<Record<string, unknown>> = []
): MorphoPositionsResponse {
  const vaultPositions: MorphoVaultPosition[] = positions.map((position) => ({
    vault: {
      address: getAddress(position.vaultAddress),
      name: position.vaultName,
      version: "v2",
      asset: {
        address: BASE_USDC_ADDRESS,
        symbol: "USDC"
      }
    },
    supplied: {
      symbol: "USDC",
      value: position.suppliedUsdc
    },
    suppliedUsd: position.suppliedUsdc
  }));

  return {
    chain: "base",
    userAddress: walletAddress,
    totals: {
      vaultCount: vaultPositions.length,
      marketCount: marketPositions.length,
      suppliedUsd: positions.reduce((acc, position) => acc + Number(position.suppliedUsdc), 0).toString(),
      borrowedUsd: "0",
      collateralUsd: "0",
      netWorthUsd: "0"
    },
    vaultPositions,
    marketPositions
  };
}

function fixtureBalance(walletAddress: string, amount: string): MorphoTokenBalanceResponse {
  return {
    chain: "base",
    userAddress: walletAddress,
    asset: {
      address: BASE_USDC_ADDRESS,
      symbol: "USDC"
    },
    balance: {
      symbol: "USDC",
      value: amount
    }
  };
}

function fixtureDeps(scenario: Scenario): PlanReadDeps {
  const vaultDetails = scenario.vaults.map(fixtureVault);
  const walletAddress = scenario.profile.walletAddress ?? SCENARIO_WALLET;

  return {
    queryVaults: async () => vaultDetails,
    getPositions: async () =>
      fixturePositions(walletAddress, scenario.positions, scenario.marketPositions ?? []),
    getTokenBalance: async () => fixtureBalance(walletAddress, scenario.idleUsdc)
  };
}

async function materializeProfile(
  settings: VaultManagerSettings,
  scenario: Scenario
): Promise<VaultManagerProfile> {
  const walletAddress = scenario.profile.walletAddress ?? SCENARIO_WALLET;
  const riskPreset = RISK_PRESETS[scenario.profile.riskProfile];

  const profile: VaultManagerProfile = {
    profileId: `eval-${scenario.id}`,
    chain: "base",
    walletRef: `eval-wallet-${scenario.id}`,
    walletAddress,
    walletMode: "existing",
    riskProfile: scenario.profile.riskProfile,
    tokenEnvVar: `OWS_EVAL_${scenario.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    usdcAddress: BASE_USDC_ADDRESS,
    agentId: `vault-manager-eval-${scenario.id}`,
    workspaceDir: path.join(settings.workspaceRoot, `workspace-eval-${scenario.id}`),
    cronJobId: undefined,
    cronJobName: `Eval ${scenario.id}`,
    cronExpression: "0 */6 * * *",
    timezone: "UTC",
    notifications: "none",
    deliveryChannel: undefined,
    deliveryTo: undefined,
    deliveryAccountId: undefined,
    cronEnabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    riskPreset
  };

  await saveProfile(settings, profile);
  return profile;
}

async function makeGatewayWarningSettings(): Promise<VaultManagerSettings> {
  const settings = makeTempSettings();
  const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-manager-openclaw-"));
  const scriptPath = path.join(scriptDir, "openclaw");
  await fs.writeFile(scriptPath, "#!/bin/sh\nexit 1\n", "utf8");
  await fs.chmod(scriptPath, 0o755);
  settings.openclawCommand = scriptPath;
  return settings;
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`${label} expected ${String(expected)} but got ${String(actual)}`);
  }
}

function assertContainsReason(result: PlanResult, substring: string): void {
  const match = result.reasons.some((reason) => reason.includes(substring));
  if (!match) {
    throw new Error(
      `expected a reason containing "${substring}", got [${result.reasons.map((reason) => JSON.stringify(reason)).join(", ")}]`
    );
  }
}

function makeTempSettings(): VaultManagerSettings {
  const dataRoot = path.join(
    os.tmpdir(),
    `vault-manager-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return {
    dataRoot,
    workspaceRoot: path.join(dataRoot, "workspace"),
    defaultProfilePath: path.join(dataRoot, "profiles", "default.json"),
    owsCommand: "ows",
    openclawCommand: "openclaw",
    morphoCliCommand: "bunx",
    morphoCliArgsPrefix: ["--package", "@morpho-org/cli", "morpho"],
    defaultChain: "base",
    defaultCron: "0 */6 * * *",
    defaultTimezone: "UTC",
    defaultDeliveryMode: "announce",
    defaultDeliveryChannel: "last",
    defaultTokenEnvVar: "OWS_MORPHO_VAULT_MANAGER_TOKEN",
    defaultTokenSource: {
      kind: "env",
      envVar: "OWS_MORPHO_VAULT_MANAGER_TOKEN"
    },
    baseAgentId: "vault-manager",
    baseCronName: "Morpho Vault Rebalance",
  };
}

type FakeCall = { command: string; args: string[] };
type FakeResponder = (call: FakeCall) => { stdout: string; stderr: string; code: number };

function fakeOwsDeps(respond: FakeResponder, calls: FakeCall[]) {
  return {
    runCommand: async (command: string, args: string[]) => {
      calls.push({ command, args });
      return respond({ command, args });
    },
    commandExists: async () => true,
    runShell: async () => ({ stdout: "", stderr: "", code: 0 }),
    generatePassphrase: () => "testpass".padEnd(64, "0"),
    now: () => new Date("2026-04-17T00:00:00.000Z")
  };
}

const FIXTURE_WALLET_CREATE_STDOUT = [
  "Created wallet 3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff",
  "  eip155:1     0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B    m/44'/60'/0'/0/0",
  "  eip155:8453  0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B    m/44'/60'/0'/0/0",
  "",
  "Recovery phrase (write this down):",
  "abandon ability able about above absent absorb abstract absurd abuse access accident",
  ""
].join("\n");

function toUsdc(value: string): bigint {
  return parseUnits(value, USDC_DECIMALS);
}

const SCENARIOS: Scenario[] = [
  {
    id: "REB-001",
    description: "Dry-run no-op with zero balance",
    profile: {
      riskProfile: "balanced"
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [],
    idleUsdc: "0",
    expect(result) {
      assertEqual("status", result.status, "no_op");
      assertContainsReason(result, "No USDC balance");
    }
  },
  {
    id: "REB-002",
    description: "No-op when positions already match targets",
    profile: {
      riskProfile: "balanced"
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [
      { vaultAddress: VAULT_A.address, vaultName: VAULT_A.name, suppliedUsdc: "5000" },
      { vaultAddress: VAULT_B.address, vaultName: VAULT_B.name, suppliedUsdc: "5000" }
    ],
    idleUsdc: "0",
    expect(result) {
      assertEqual("status", result.status, "no_op");
      assertContainsReason(result, "current positions match computed targets");
    }
  },
  {
    id: "REB-003",
    description: "Plan produces actions for idle USDC",
    profile: {
      riskProfile: "balanced"
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [],
    idleUsdc: "5000",
    expect(result) {
      assertEqual("status", result.status, "planned");
      if (result.actions.length === 0) {
        throw new Error("expected at least one planned action");
      }
      const totalAction = result.actions.reduce(
        (acc: bigint, action: { amountUsdc: string }) => acc + toUsdc(action.amountUsdc),
        0n
      );
      const expectedMin = toUsdc("4800");
      if (totalAction < expectedMin) {
        throw new Error(
          `expected total action >= ${formatUnits(expectedMin, USDC_DECIMALS)} USDC, got ${formatUnits(totalAction, USDC_DECIMALS)}`
        );
      }
    }
  },
  {
    id: "OBS-001",
    description: "Run logging is auditable and secret-free",
    profile: {
      riskProfile: "balanced"
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [],
    idleUsdc: "5000",
    async expect(result) {
      assertEqual("status", result.status, "planned");
      if (!result.logPath) {
        throw new Error("expected logPath on result");
      }
      const raw = await fs.readFile(result.logPath, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      if (lines.length < 3) {
        throw new Error(`expected at least 3 log lines, got ${lines.length}`);
      }
      const phases = new Set<string>();
      for (const line of lines) {
        const event = JSON.parse(line) as {
          runId?: string;
          phase?: string;
          payload?: Record<string, unknown>;
        };
        if (event.runId !== result.runId) {
          throw new Error(`log runId ${event.runId} did not match run ${result.runId}`);
        }
        if (event.phase) phases.add(event.phase);
        const serialized = JSON.stringify(event);
        if (/OWS_[A-Z0-9_]*TOKEN\"\s*:\s*\"[^\"\[]/i.test(serialized)) {
          throw new Error("log contains unredacted token value");
        }
      }
      for (const required of ["start", "read", "plan", "complete"]) {
        if (!phases.has(required)) {
          throw new Error(`expected phase "${required}" in logs, got [${[...phases].join(", ")}]`);
        }
      }
    }
  },
  {
    id: "REB-008",
    description: "Turnover cap blocks instead of clipping",
    profile: {
      riskProfile: "balanced"
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [],
    idleUsdc: "20000",
    expect(result) {
      assertEqual("status", result.status, "blocked");
      assertContainsReason(result, "exceeds the configured cap");
      assertTrue("planned actions", result.actions.length > 0);
      if (toUsdc(result.metrics.totalPlannedTurnoverUsdc) <= toUsdc(result.metrics.turnoverCapUsdc)) {
        throw new Error(
          `expected proposed turnover to exceed cap, got ${result.metrics.totalPlannedTurnoverUsdc} <= ${result.metrics.turnoverCapUsdc}`
        );
      }
    }
  },
  {
    id: "REB-009",
    description: "Non-vault Morpho market positions block execution",
    profile: {
      riskProfile: "balanced"
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [
      { vaultAddress: VAULT_A.address, vaultName: VAULT_A.name, suppliedUsdc: "5000" }
    ],
    marketPositions: [
      {
        marketAddress: "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
        suppliedUsd: "100"
      }
    ],
    idleUsdc: "1000",
    expect(result) {
      assertEqual("status", result.status, "blocked");
      assertContainsReason(result, "non-vault Morpho market position");
    }
  },
  {
    id: "REB-010",
    description: "Top vault set changes materially trigger a rebalance",
    profile: {
      riskProfile: "balanced"
    },
    vaults: [VAULT_A, VAULT_B, VAULT_C, VAULT_D],
    positions: [
      { vaultAddress: VAULT_A.address, vaultName: VAULT_A.name, suppliedUsdc: "4950" },
      { vaultAddress: VAULT_B.address, vaultName: VAULT_B.name, suppliedUsdc: "3300" },
      { vaultAddress: VAULT_C.address, vaultName: VAULT_C.name, suppliedUsdc: "1550" },
      { vaultAddress: VAULT_D.address, vaultName: VAULT_D.name, suppliedUsdc: "100" }
    ],
    idleUsdc: "0",
    expect(result) {
      assertEqual("status", result.status, "planned");
      const withdrewFromTopSetChange = result.actions.some(
        (action: { kind: string; vaultAddress: string }) => action.kind === "withdraw" && action.vaultAddress === VAULT_D.address
      );
      assertTrue("withdraw from changed top set", withdrewFromTopSetChange);
    }
  },
  {
    id: "REB-011",
    description: "Drift below threshold produces no-op",
    profile: {
      riskProfile: "balanced"
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [
      { vaultAddress: VAULT_A.address, vaultName: VAULT_A.name, suppliedUsdc: "5200" },
      { vaultAddress: VAULT_B.address, vaultName: VAULT_B.name, suppliedUsdc: "4800" }
    ],
    idleUsdc: "0",
    expect(result) {
      assertEqual("status", result.status, "no_op");
      assertContainsReason(result, "below the");
      assertContainsReason(result, "threshold");
    }
  },
  {
    id: "REB-012",
    description: "Drift above threshold triggers rebalance",
    profile: {
      riskProfile: "aggressive"
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [
      { vaultAddress: VAULT_A.address, vaultName: VAULT_A.name, suppliedUsdc: "8000" },
      { vaultAddress: VAULT_B.address, vaultName: VAULT_B.name, suppliedUsdc: "2000" }
    ],
    idleUsdc: "0",
    expect(result) {
      assertEqual("status", result.status, "planned");
      assertTrue("has actions", result.actions.length > 0);
    }
  }
];

async function runScenario(scenario: Scenario): Promise<void> {
  const settings = makeTempSettings();
  const profile = await materializeProfile(settings, scenario);
  const deps = scenario.depsFactory ? scenario.depsFactory(scenario) : fixtureDeps(scenario);

  const result = await runPlan(settings, profile.profileId, deps);
  await scenario.expect(result);
}

type SystemScenario = {
  id: string;
  description: string;
  run: () => Promise<void>;
};

async function runSystemScenario(scenario: SystemScenario): Promise<void> {
  await scenario.run();
}

function assertTrue(label: string, value: boolean, detail?: string): void {
  if (!value) {
    throw new Error(`${label} expected true${detail ? ` (${detail})` : ""}`);
  }
}

function assertFalse(label: string, value: boolean, detail?: string): void {
  if (value) {
    throw new Error(`${label} expected false${detail ? ` (${detail})` : ""}`);
  }
}

const SYSTEM_SCENARIOS: SystemScenario[] = [
  {
    id: "CFG-001",
    description: "Fresh machine preflight passes",
    async run() {
      const settings = resolvePreflightSettings(true);
      const result = await runPreflightChecks(settings);
      assertTrue(
        "preflight.ok",
        result.ok,
        result.issues.map((issue) => issue.message).join("; ") || "no issues reported"
      );
      assertTrue("openclaw", result.checked.openclaw);
      assertTrue("ows", result.checked.ows);
      assertTrue("morphoCli", result.checked.morphoCli);
    }
  },
  {
    id: "CFG-002",
    description: "Missing dependency fails loudly",
    async run() {
      const settings = resolvePreflightSettings(true);
      settings.openclawCommand = "openclaw-nonexistent-binary-for-eval";
      const result = await runPreflightChecks(settings);
      assertFalse("preflight.ok", result.ok);
      const hasMissingOpenclaw = result.issues.some((issue) => issue.code === "missing_openclaw");
      assertTrue("missing_openclaw_issue", hasMissingOpenclaw, JSON.stringify(result.issues));
    }
  },
  {
    id: "CFG-003",
    description: "Gateway absence emits remediation-friendly warning",
    async run() {
      const settings = await makeGatewayWarningSettings();
      const result = await runPreflightChecks(settings);
      assertFalse("preflight.ok", result.ok);
      const gatewayIssue = result.issues.find((issue) => issue.code === "openclaw_gateway_unreachable");
      assertTrue("gateway_issue_present", Boolean(gatewayIssue), JSON.stringify(result.issues));
      if (!gatewayIssue) throw new Error("unreachable");
      if (!gatewayIssue.message.includes("daemon")) {
        throw new Error(`expected daemon guidance in gateway message, got ${JSON.stringify(gatewayIssue.message)}`);
      }
      if (!gatewayIssue.remediation?.some((line) => line.includes("gateway status"))) {
        throw new Error(`expected gateway status remediation, got ${JSON.stringify(gatewayIssue.remediation)}`);
      }
      assertFalse("gatewayReachable", result.checked.gatewayReachable);
    }
  },
  {
    id: "CFG-004",
    description: "Cron presets and risk config render deterministically",
    async run() {
      assertEqual("hourly", CRON_SCHEDULE_PRESETS.hourly.cronExpression, "0 * * * *");
      assertEqual("every6Hours", CRON_SCHEDULE_PRESETS.every6Hours.cronExpression, "0 */6 * * *");
      assertEqual("daily", CRON_SCHEDULE_PRESETS.daily.cronExpression, "0 0 * * *");
      assertEqual("weekdays", CRON_SCHEDULE_PRESETS.weekdays.cronExpression, "0 0 * * 1-5");
      assertEqual("weekday schedule label", describeCronSchedule("0 0 * * 1-5"), "Weekdays (0 0 * * 1-5)");

      const riskJson = formatRiskPresetConfig(RISK_PRESETS.balanced);
      const parsed = JSON.parse(riskJson) as {
        id: string;
        maxVaults: number;
        scoreWeights: { apy: number };
      };
      assertEqual("risk id", parsed.id, "balanced");
      assertEqual("risk maxVaults", parsed.maxVaults, 3);
      assertEqual("risk apy weight", parsed.scoreWeights.apy, 1);
    }
  },
  {
    id: "CFG-005",
    description: "Cron delivery defaults resolve deterministically",
    async run() {
      const settings = makeTempSettings();
      assertEqual("default delivery mode", settings.defaultDeliveryMode, "announce");
      assertEqual("default delivery channel", settings.defaultDeliveryChannel, "last");
      assertEqual("default delivery to", settings.defaultDeliveryTo, undefined);
    }
  },
  {
    id: "WAL-001",
    description: "Wallet create command is deterministic and excludes secrets",
    async run() {
      const settings = makeTempSettings();
      const command = buildWalletCreateCommand(settings, "vault-manager-test");
      assertTrue("starts with ows", command.startsWith(`${settings.owsCommand} wallet create`));
      assertTrue("has name flag", command.includes('--name "vault-manager-test"'));
      if (/mnemonic|passphrase|token/i.test(command)) {
        throw new Error("wallet create command should not contain secret material");
      }

      const apiKeyCommand = buildApiKeyCreateCommand({
        settings,
        keyName: "vault-manager-test-agent",
        walletRef: "vault-manager-test"
      });
      assertFalse("api key references policy", apiKeyCommand.includes("--policy"));
      if (/token=|passphrase=|--secret/.test(apiKeyCommand)) {
        throw new Error("api key command should not contain inline secret material");
      }
    }
  },
  {
    id: "CRN-001",
    description: "Cron environment is ready (OpenClaw gateway reachable)",
    async run() {
      const settings = resolvePreflightSettings(true);
      const reachable = await openclawGatewayIsReachable(settings);
      assertTrue(
        "gatewayReachable",
        reachable,
        "openclaw gateway status did not return success"
      );
    }
  },
  {
    id: "CRN-002",
    description: "Cron environment warns when gateway is absent",
    async run() {
      const settings = resolvePreflightSettings(true);
      settings.openclawCommand = "openclaw-nonexistent-binary-for-eval";
      const reachable = await openclawGatewayIsReachable(settings);
      assertFalse("gatewayReachable", reachable);
    }
  },
  {
    id: "REB-004",
    description: "Agent instructions enforce stop on first simulation failure",
    async run() {
      const riskPreset = RISK_PRESETS.balanced;
      const profile: VaultManagerProfile = {
        profileId: "eval-reb004",
        chain: "base",
        walletRef: "eval-wallet",
        walletAddress: getAddress("0x1111111111111111111111111111111111111111"),
        walletMode: "existing",
        riskProfile: "balanced",
        tokenEnvVar: "OWS_EVAL_TOKEN",
        usdcAddress: BASE_USDC_ADDRESS,
        agentId: "vault-manager-eval",
        workspaceDir: "/tmp/eval-reb004",
        cronJobName: "Eval REB-004",
        cronExpression: "0 */6 * * *",
        timezone: "UTC",
        notifications: "none",
        cronEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        riskPreset
      };

      const instructions = renderAgentInstructions(profile);
      assertTrue(
        "contains stop-on-failure instruction",
        instructions.includes("simulation failed, stop immediately")
      );
      assertTrue(
        "contains reject-on-simulation-failure rule",
        instructions.includes("Reject execution if simulation fails")
      );
      assertTrue(
        "no-op section lists simulation failure",
        instructions.includes("Simulation failure") &&
          instructions.indexOf("No-Op Conditions") < instructions.indexOf("Simulation failure")
      );
    }
  },
  {
    id: "SEC-001",
    description: "Host-resolved SecretRef flows into inline token source",
    async run() {
      const envVarSource = tokenSourceFromPluginConfig(
        { source: "env", provider: "default", id: "OWS_EVAL_ENV_TOKEN" },
        "OWS_MORPHO_VAULT_MANAGER_TOKEN"
      );
      assertEqual("envVarSource.kind", envVarSource.kind, "env");
      if (envVarSource.kind !== "env") throw new Error("unreachable");
      assertEqual("envVarSource.envVar", envVarSource.envVar, "OWS_EVAL_ENV_TOKEN");

      const fileSource = tokenSourceFromPluginConfig(
        { source: "file", provider: "mounted", id: "/run/secrets/morpho-token" },
        "OWS_MORPHO_VAULT_MANAGER_TOKEN"
      );
      assertEqual("fileSource.kind", fileSource.kind, "file");
      if (fileSource.kind !== "file") throw new Error("unreachable");
      assertEqual("fileSource.path", fileSource.path, "/run/secrets/morpho-token");

      const inlineSource = tokenSourceFromPluginConfig(
        "oc-token-host-resolved-xyz-987",
        "OWS_MORPHO_VAULT_MANAGER_TOKEN",
        { inlineOrigin: "test:plugin-config:apiKey" }
      );
      assertEqual("inlineSource.kind", inlineSource.kind, "inline");
      registerInlineToken("test:plugin-config:apiKey", "oc-token-host-resolved-xyz-987");

      const resolution = await resolveApiToken(inlineSource);
      assertTrue("inlineResolution.ok", resolution.ok);
      if (!resolution.ok) throw new Error("unreachable");
      assertEqual("inlineResolution.value", resolution.value, "oc-token-host-resolved-xyz-987");
      assertTrue(
        "inlineResolution.description is inline",
        describeTokenSource(inlineSource).startsWith("inline:")
      );
    }
  },
  {
    id: "OBS-BOOT-PARSER-001",
    description: "parseOwsWalletCreateOutput handles the happy path",
    async run() {
      const stdout = [
        "Created wallet 3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff",
        "  eip155:1     0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B    m/44'/60'/0'/0/0",
        "  eip155:8453  0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B    m/44'/60'/0'/0/0",
        "",
        "Recovery phrase (write this down):",
        "abandon ability able about above absent absorb abstract absurd abuse access accident",
        ""
      ].join("\n");
      const parsed = parseOwsWalletCreateOutput(stdout);
      if ("error" in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);
      assertEqual("walletRef", parsed.walletRef, "3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff");
      assertEqual(
        "walletAddress",
        parsed.walletAddress,
        "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"
      );
      assertEqual("mnemonic word count", parsed.mnemonic.split(/\s+/).length, 12);
    }
  },
  {
    id: "OBS-BOOT-PARSER-002",
    description: "parseOwsWalletCreateOutput rejects missing mnemonic",
    async run() {
      const stdout = [
        "Created wallet 3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff",
        "  eip155:1     0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"
      ].join("\n");
      const parsed = parseOwsWalletCreateOutput(stdout);
      assertTrue("returned error", "error" in parsed);
    }
  },
  {
    id: "OBS-BOOT-PARSER-003",
    description: "parseOwsWalletCreateOutput rejects missing wallet id",
    async run() {
      const parsed = parseOwsWalletCreateOutput("nothing to parse");
      assertTrue("returned error", "error" in parsed);
    }
  },
  {
    id: "OBS-BOOT-PARSER-004",
    description: "parseOwsWalletList extracts names and wallet refs",
    async run() {
      const stdout = [
        "morpho-vault-manager  3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff",
        "  eip155:1     0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
        "  eip155:8453  0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
        "",
        "other-wallet  01234567-89ab-cdef-0123-456789abcdef",
        "  eip155:1     0x0000000000000000000000000000000000000001"
      ].join("\n");
      const wallets = parseOwsWalletList(stdout);
      assertEqual("count", wallets.length, 2);
      assertEqual("first name", wallets[0].name, "morpho-vault-manager");
      assertEqual("first ref", wallets[0].walletRef, "3198bc9c-aaaa-bbbb-cccc-ddddeeeeffff");
    }
  },
  {
    id: "OBS-BOOT-PARSER-005",
    description: "parseOwsWalletList handles empty output",
    async run() {
      assertEqual("empty", parseOwsWalletList("").length, 0);
    }
  },
  {
    id: "OBS-BOOT-PARSER-006",
    description: "parseOwsKeyCreateOutput extracts the token",
    async run() {
      const parsed = parseOwsKeyCreateOutput(
        "Created API key claude-agent (id: abcd-1234)\nToken: ows_key_a1b2c3d4e5f6\n"
      );
      if ("error" in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);
      assertEqual("token", parsed.token, "ows_key_a1b2c3d4e5f6");
    }
  },
  {
    id: "OBS-BOOT-PARSER-007",
    description: "parseOwsKeyCreateOutput rejects missing token",
    async run() {
      const parsed = parseOwsKeyCreateOutput("no token here");
      assertTrue("returned error", "error" in parsed);
    }
  },
  {
    id: "CFG-006",
    description: "Zero-touch auto-create: empty OWS + no marker → wallet + marker written",
    async run() {
      const settings = makeTempSettings();
      const calls: FakeCall[] = [];
      const deps = fakeOwsDeps(({ args }) => {
        if (args[0] === "wallet" && args[1] === "list") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args[0] === "wallet" && args[1] === "create") {
          return { stdout: FIXTURE_WALLET_CREATE_STDOUT, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "unexpected", code: 1 };
      }, calls);

      const resolution = await resolveOrCreateWallet(
        settings,
        { profileId: "default" },
        deps
      );

      assertEqual("source", resolution.source, "auto-created");
      assertEqual(
        "wallet address",
        resolution.walletAddress,
        "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"
      );
      assertEqual("canonical name", resolution.canonicalName, "morpho-vault-manager");

      const marker = await readWalletMarker(settings, "default");
      if (!marker) throw new Error("marker file was not written");
      assertEqual("marker source", marker.source, "auto-created");
      if (!marker.mnemonic) throw new Error("marker did not capture the mnemonic");

      assertEqual("call count", calls.length, 2);
      assertEqual("first call", calls[0].args.slice(0, 2).join(" "), "wallet list");
      assertEqual("second call", calls[1].args.slice(0, 2).join(" "), "wallet create");
    }
  },
  {
    id: "CFG-007",
    description: "Marker reuse: existing marker short-circuits wallet list + create",
    async run() {
      const settings = makeTempSettings();
      const calls: FakeCall[] = [];
      const deps = fakeOwsDeps(() => ({ stdout: "", stderr: "unexpected call", code: 1 }), calls);

      await writeWalletMarker(settings, "default", {
        walletRef: "existing-uuid",
        walletAddress: "0x1111111111111111111111111111111111111111",
        passphrase: "stored-passphrase",
        source: "auto-created",
        canonicalName: "morpho-vault-manager",
        createdAt: "2026-04-01T00:00:00.000Z"
      });

      const resolution = await resolveOrCreateWallet(
        settings,
        { profileId: "default" },
        deps
      );

      assertEqual("source", resolution.source, "marker");
      assertEqual("walletRef", resolution.walletRef, "existing-uuid");
      assertEqual("passphrase", resolution.passphrase, "stored-passphrase");
      assertEqual("no ows calls", calls.length, 0);
    }
  },
];

function resolvePreflightSettings(inheritPath: boolean): ReturnType<typeof makeTempSettings> {
  const settings = makeTempSettings();
  if (inheritPath) {
    settings.openclawCommand = "openclaw";
    settings.owsCommand = "ows";
    settings.morphoCliCommand = "bunx";
  }
  return settings;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).find((arg) => arg.startsWith("--only="))?.split("=")[1];

  const rebalanceSelected = only
    ? SCENARIOS.filter((scenario) => scenario.id === only)
    : SCENARIOS;
  const systemSelected = only
    ? SYSTEM_SCENARIOS.filter((scenario) => scenario.id === only)
    : SYSTEM_SCENARIOS;

  const totalSelected = rebalanceSelected.length + systemSelected.length;
  if (totalSelected === 0) {
    throw new Error(`No matching scenarios for filter ${only}`);
  }

  let failed = 0;

  for (const scenario of systemSelected) {
    process.stdout.write(`[eval] ${scenario.id} ${scenario.description} ... `);
    try {
      await runSystemScenario(scenario);
      process.stdout.write("pass\n");
    } catch (error) {
      failed += 1;
      process.stdout.write(`fail\n  ${(error as Error).message}\n`);
    }
  }

  for (const scenario of rebalanceSelected) {
    process.stdout.write(`[eval] ${scenario.id} ${scenario.description} ... `);
    try {
      await runScenario(scenario);
      process.stdout.write("pass\n");
    } catch (error) {
      failed += 1;
      process.stdout.write(`fail\n  ${(error as Error).message}\n`);
    }
  }

  if (failed > 0) {
    process.stderr.write(`\n${failed} scenario(s) failed.\n`);
    process.exit(1);
  }

  process.stdout.write(`\nAll ${totalSelected} scenario(s) passed.\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? (error as Error).message}\n`);
  process.exitCode = 1;
});
