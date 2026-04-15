import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAddress, parseUnits, formatUnits } from "viem";
import { BASE_CHAIN_ID, BASE_USDC_ADDRESS, RISK_PRESETS, USDC_DECIMALS } from "../lib/constants.js";
import { openclawGatewayIsReachable } from "../lib/openclaw.js";
import { buildApiKeyCreateCommand, buildWalletCreateCommand } from "../lib/ows.js";
import { writePolicyArtifacts } from "../lib/policy.js";
import { runPreflightChecks } from "../lib/preflight.js";
import {
  describeTokenSource,
  registerInlineToken,
  resolveApiToken,
  tokenSourceFromPluginConfig
} from "../lib/secrets.js";
import type {
  MorphoPositionsResponse,
  MorphoPreparedOperation,
  MorphoTokenBalanceResponse,
  MorphoVaultDetail,
  MorphoVaultPosition
} from "../lib/morpho.js";
import { saveProfile } from "../lib/profile.js";
import {
  runRebalance,
  type RebalanceReadDeps,
  type RebalanceRunResult
} from "../lib/rebalance.js";
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
    allowedVaults: string[];
    walletAddress?: string;
  };
  vaults: VaultFixture[];
  positions: PositionFixture[];
  idleUsdc: string;
  expect: (result: RebalanceRunResult) => void | Promise<void>;
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
  positions: PositionFixture[]
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
      marketCount: 0,
      suppliedUsd: positions.reduce((acc, position) => acc + Number(position.suppliedUsdc), 0).toString(),
      borrowedUsd: "0",
      collateralUsd: "0",
      netWorthUsd: "0"
    },
    vaultPositions,
    marketPositions: []
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

function fixturePreparedOperation(params: {
  kind: "deposit" | "withdraw";
  vaultAddress: string;
  walletAddress: string;
  amount: string;
  succeed: boolean;
}): MorphoPreparedOperation {
  return {
    operation: params.kind === "deposit" ? "vault-supply" : "vault-withdraw",
    chain: "base",
    summary: `${params.kind} ${params.amount} USDC via ${params.vaultAddress}`,
    transactions: [
      {
        to: getAddress(params.vaultAddress),
        data: "0xdeadbeef",
        value: "0",
        chainId: "eip155:8453",
        description: `${params.kind} ${params.amount} USDC`
      }
    ],
    simulated: true,
    simulationOk: params.succeed,
    warnings: params.succeed
      ? []
      : [{ level: "error", message: "Simulation failed (fixture)." }]
  };
}

function fixtureDeps(scenario: Scenario): RebalanceReadDeps {
  const vaultMap = new Map(scenario.vaults.map((vault) => [vault.address, fixtureVault(vault)]));
  const walletAddress = scenario.profile.walletAddress ?? SCENARIO_WALLET;

  return {
    getVault: async (address) => {
      const vault = vaultMap.get(getAddress(address));
      if (!vault) throw new Error(`Fixture missing vault ${address}`);
      return vault;
    },
    getPositions: async () => fixturePositions(walletAddress, scenario.positions),
    getTokenBalance: async () => fixtureBalance(walletAddress, scenario.idleUsdc),
    prepareDeposit: async (vaultAddress, _walletAddress, amount) =>
      fixturePreparedOperation({
        kind: "deposit",
        vaultAddress,
        walletAddress,
        amount,
        succeed: true
      }),
    prepareWithdraw: async (vaultAddress, _walletAddress, amount) =>
      fixturePreparedOperation({
        kind: "withdraw",
        vaultAddress,
        walletAddress,
        amount,
        succeed: true
      })
  };
}

function fixtureDepsWithSimulationFailure(scenario: Scenario): RebalanceReadDeps {
  const base = fixtureDeps(scenario);
  return {
    ...base,
    prepareDeposit: async (vaultAddress, _walletAddress, amount) =>
      fixturePreparedOperation({
        kind: "deposit",
        vaultAddress,
        walletAddress: scenario.profile.walletAddress ?? SCENARIO_WALLET,
        amount,
        succeed: false
      })
  };
}

async function materializeProfile(
  settings: VaultManagerSettings,
  scenario: Scenario
): Promise<VaultManagerProfile> {
  const walletAddress = scenario.profile.walletAddress ?? SCENARIO_WALLET;
  const allowedVaults = scenario.profile.allowedVaults.map((address) => getAddress(address));
  const riskPreset = RISK_PRESETS[scenario.profile.riskProfile];

  const profile: VaultManagerProfile = {
    profileId: `eval-${scenario.id}`,
    chain: "base",
    walletRef: `eval-wallet-${scenario.id}`,
    walletAddress,
    walletMode: "existing",
    riskProfile: scenario.profile.riskProfile,
    allowedVaults,
    allowedSpenders: allowedVaults,
    tokenEnvVar: `OWS_EVAL_${scenario.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    usdcAddress: BASE_USDC_ADDRESS,
    policyId: `eval-policy-${scenario.id}`,
    policyFile: path.join(settings.dataRoot, "eval", `${scenario.id}-policy.json`),
    policyExecutable: path.join(settings.dataRoot, "eval", `${scenario.id}-policy.ts`),
    agentId: `vault-manager-eval-${scenario.id}`,
    workspaceDir: path.join(settings.workspaceRoot, `workspace-eval-${scenario.id}`),
    cronJobId: undefined,
    cronJobName: `Eval ${scenario.id}`,
    cronExpression: "0 */6 * * *",
    timezone: "UTC",
    notifications: "none",
    cronEnabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    riskPreset
  };

  await saveProfile(settings, profile);
  return profile;
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`${label} expected ${String(expected)} but got ${String(actual)}`);
  }
}

function assertContainsReason(result: RebalanceRunResult, substring: string): void {
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
    defaultTokenEnvVar: "OWS_MORPHO_VAULT_MANAGER_TOKEN",
    defaultTokenSource: {
      kind: "env",
      envVar: "OWS_MORPHO_VAULT_MANAGER_TOKEN"
    },
    baseAgentId: "vault-manager",
    baseCronName: "Morpho Vault Rebalance",
    dryRunByDefault: true
  };
}

function toUsdc(value: string): bigint {
  return parseUnits(value, USDC_DECIMALS);
}

const SCENARIOS: Scenario[] = [
  {
    id: "REB-001",
    description: "Dry-run no-op with zero balance",
    profile: {
      riskProfile: "balanced",
      allowedVaults: [VAULT_A.address, VAULT_B.address]
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
    description: "Dry-run no-op below drift threshold",
    profile: {
      riskProfile: "balanced",
      allowedVaults: [VAULT_A.address, VAULT_B.address]
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [
      { vaultAddress: VAULT_A.address, vaultName: VAULT_A.name, suppliedUsdc: "5000" },
      { vaultAddress: VAULT_B.address, vaultName: VAULT_B.name, suppliedUsdc: "5000" }
    ],
    idleUsdc: "100",
    expect(result) {
      assertEqual("status", result.status, "no_op");
      assertContainsReason(result, "below the configured threshold");
    }
  },
  {
    id: "REB-003",
    description: "Dry-run produces transaction plan",
    profile: {
      riskProfile: "balanced",
      allowedVaults: [VAULT_A.address, VAULT_B.address]
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
        (acc, action) => acc + toUsdc(action.amountUsdc),
        0n
      );
      const expectedMin = toUsdc("4800");
      if (totalAction < expectedMin) {
        throw new Error(
          `expected total action >= ${formatUnits(expectedMin, USDC_DECIMALS)} USDC, got ${formatUnits(totalAction, USDC_DECIMALS)}`
        );
      }
      for (const operation of result.operations) {
        if (!operation.simulationOk) {
          throw new Error(`operation ${operation.vaultAddress} reports simulation failure`);
        }
      }
    }
  },
  {
    id: "REB-004",
    description: "Simulation failure blocks execution",
    profile: {
      riskProfile: "balanced",
      allowedVaults: [VAULT_A.address, VAULT_B.address]
    },
    vaults: [VAULT_A, VAULT_B],
    positions: [],
    idleUsdc: "5000",
    expect(result) {
      assertEqual("status", result.status, "blocked");
      const failed = result.operations.find((operation) => !operation.simulationOk);
      if (!failed) {
        throw new Error("expected at least one failed operation in blocked run");
      }
    }
  },
  {
    id: "OBS-001",
    description: "Run logging is auditable and secret-free",
    profile: {
      riskProfile: "balanced",
      allowedVaults: [VAULT_A.address, VAULT_B.address]
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
      for (const required of ["start", "read", "plan", "prepare", "complete"]) {
        if (!phases.has(required)) {
          throw new Error(`expected phase "${required}" in logs, got [${[...phases].join(", ")}]`);
        }
      }
    }
  }
];

async function runScenario(scenario: Scenario): Promise<void> {
  const settings = makeTempSettings();
  const profile = await materializeProfile(settings, scenario);
  const deps =
    scenario.id === "REB-004"
      ? fixtureDepsWithSimulationFailure(scenario)
      : fixtureDeps(scenario);

  const result = await runRebalance(settings, profile.profileId, "dry-run", deps);
  await scenario.expect(result);
}

type PolicyDecision = { allow: boolean; reason?: string };

async function runPolicyExecutable(
  executablePath: string,
  context: Record<string, unknown>
): Promise<PolicyDecision> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [executablePath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`policy executable exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as PolicyDecision);
      } catch (parseError) {
        reject(new Error(`invalid policy output: ${(parseError as Error).message}\n${stdout}`));
      }
    });
    child.stdin.write(JSON.stringify(context));
    child.stdin.end();
  });
}

function encodeCallData(selector: string, words: string[]): `0x${string}` {
  return `${selector}${words.map((word) => word.padStart(64, "0")).join("")}` as `0x${string}`;
}

function addressAsWord(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function uintAsWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

type PolicyScenario = {
  id: string;
  description: string;
  setup: (params: { executablePath: string }) => Promise<Record<string, unknown>>;
  expect: (decision: PolicyDecision) => void;
};

const VAULT_ALLOWED = getAddress("0xcccccccccccccccccccccccccccccccccccccccc");
const VAULT_FORBIDDEN = getAddress("0xdddddddddddddddddddddddddddddddddddddddd");

async function buildPolicyEnvironment(): Promise<{ executablePath: string }> {
  const settings = makeTempSettings();
  await fs.mkdir(settings.dataRoot, { recursive: true });
  const artifacts = await writePolicyArtifacts({
    settings,
    profileId: "eval",
    allowedVaults: [VAULT_ALLOWED],
    allowedSpenders: [VAULT_ALLOWED],
    riskPreset: RISK_PRESETS.balanced
  });
  return { executablePath: artifacts.executablePath };
}

const POLICY_SCENARIOS: PolicyScenario[] = [
  {
    id: "POL-002",
    description: "Chain restriction enforced",
    async setup() {
      return {
        chain_id: "eip155:1",
        transaction: {
          to: VAULT_ALLOWED,
          data: encodeCallData("0x6e553f65", [uintAsWord(1_000_000n), addressAsWord(SCENARIO_WALLET)]),
          value: "0"
        }
      };
    },
    expect(decision) {
      assertEqual("allow", decision.allow, false);
      if (!decision.reason?.includes("chain")) {
        throw new Error(`expected chain rejection, got ${JSON.stringify(decision)}`);
      }
    }
  },
  {
    id: "POL-003",
    description: "Spender restriction enforced",
    async setup() {
      const approveSelector = "0x095ea7b3";
      return {
        chain_id: BASE_CHAIN_ID,
        transaction: {
          to: BASE_USDC_ADDRESS,
          data: encodeCallData(approveSelector, [addressAsWord(VAULT_FORBIDDEN), uintAsWord(1_000_000n)]),
          value: "0"
        }
      };
    },
    expect(decision) {
      assertEqual("allow", decision.allow, false);
      if (!decision.reason?.toLowerCase().includes("spender")) {
        throw new Error(`expected spender rejection, got ${JSON.stringify(decision)}`);
      }
    }
  }
];

async function runPolicyScenario(scenario: PolicyScenario): Promise<void> {
  const env = await buildPolicyEnvironment();
  const context = await scenario.setup({ executablePath: env.executablePath });
  const decision = await runPolicyExecutable(env.executablePath, context);
  scenario.expect(decision);
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
        walletRef: "vault-manager-test",
        policyId: "morpho-vault-manager-default"
      });
      assertTrue(
        "api key references policy",
        apiKeyCommand.includes('--policy "morpho-vault-manager-default"')
      );
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
  }
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
  const policySelected = only
    ? POLICY_SCENARIOS.filter((scenario) => scenario.id === only)
    : POLICY_SCENARIOS;
  const systemSelected = only
    ? SYSTEM_SCENARIOS.filter((scenario) => scenario.id === only)
    : SYSTEM_SCENARIOS;

  const totalSelected = rebalanceSelected.length + policySelected.length + systemSelected.length;
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

  for (const scenario of policySelected) {
    process.stdout.write(`[eval] ${scenario.id} ${scenario.description} ... `);
    try {
      await runPolicyScenario(scenario);
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
