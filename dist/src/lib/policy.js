import { chmod } from "node:fs/promises";
import path from "node:path";
import { toFunctionSelector } from "viem";
import { BASE_CHAIN_ID, BASE_USDC_ADDRESS } from "./constants.js";
import { ensureDir, writeJsonFile, writeTextFile } from "./fs.js";
export async function writePolicyArtifacts(params) {
    const usdcAddress = params.usdcAddress ?? BASE_USDC_ADDRESS;
    const policyId = `morpho-vault-manager-${params.profileId}`;
    const policiesRoot = path.join(params.settings.dataRoot, "policies", params.profileId);
    const executablePath = path.join(policiesRoot, "morpho-allowlist-policy.mjs");
    const policyFilePath = path.join(policiesRoot, `${policyId}.json`);
    await ensureDir(policiesRoot);
    const approveSelector = toFunctionSelector("approve(address,uint256)");
    const depositSelector = toFunctionSelector("deposit(uint256,address)");
    const withdrawSelector = toFunctionSelector("withdraw(uint256,address,address)");
    const executableContent = `#!/usr/bin/env node
import { stdin, stdout, stderr } from "node:process";

const config = {
  baseChainId: ${JSON.stringify(BASE_CHAIN_ID)},
  allowedVaults: ${JSON.stringify(params.allowedVaults.map((value) => value.toLowerCase()))},
  allowedSpenders: ${JSON.stringify((params.allowedSpenders.length > 0 ? params.allowedSpenders : params.allowedVaults).map((value) => value.toLowerCase()))},
  usdcAddress: ${JSON.stringify(usdcAddress.toLowerCase())},
  approveSelector: ${JSON.stringify(approveSelector)},
  depositSelector: ${JSON.stringify(depositSelector)},
  withdrawSelector: ${JSON.stringify(withdrawSelector)},
  maxTurnoverUnits: ${JSON.stringify(BigInt(Math.round(params.riskPreset.maxTurnoverUsd * 1_000_000)).toString())}
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      input += chunk;
    });
    stdin.on("end", () => resolve(input));
    stdin.on("error", reject);
  });
}

function deny(reason) {
  stdout.write(JSON.stringify({ allow: false, reason }));
}

function allow() {
  stdout.write(JSON.stringify({ allow: true }));
}

function normalizeAddress(input) {
  if (typeof input !== "string" || !input.startsWith("0x") || input.length !== 42) {
    return null;
  }
  return input.toLowerCase();
}

function parseWord(hex, offset) {
  const start = 10 + offset * 64;
  const end = start + 64;
  if (hex.length < end) return null;
  return hex.slice(start, end);
}

function parseAddressWord(hex, offset) {
  const word = parseWord(hex, offset);
  if (!word) return null;
  return normalizeAddress("0x" + word.slice(24));
}

function parseUintWord(hex, offset) {
  const word = parseWord(hex, offset);
  if (!word) return null;
  return BigInt("0x" + word);
}

const raw = await readStdin();
const context = JSON.parse(raw);
const chainId = context?.chain_id;
const tx = context?.transaction ?? {};
const to = normalizeAddress(tx.to);
const data = typeof tx.data === "string" ? tx.data.toLowerCase() : "";
const txValue = typeof tx.value === "string" ? BigInt(tx.value) : 0n;

if (chainId !== config.baseChainId) {
  deny("chain is not allowed");
  process.exit(0);
}

if (txValue !== 0n) {
  deny("native value transfers are not allowed");
  process.exit(0);
}

if (!to) {
  deny("transaction target is missing or invalid");
  process.exit(0);
}

const selector = data.slice(0, 10);

if (selector === config.approveSelector) {
  if (to !== config.usdcAddress) {
    deny("approval target is not the configured USDC contract");
    process.exit(0);
  }

  const spender = parseAddressWord(data, 0);
  const amount = parseUintWord(data, 1);

  if (!spender || !config.allowedSpenders.includes(spender)) {
    deny("approval spender is not allowlisted");
    process.exit(0);
  }

  if (amount === null || amount > config.maxTurnoverUnits) {
    deny("approval amount exceeds the configured turnover cap");
    process.exit(0);
  }

  allow();
  process.exit(0);
}

if (!config.allowedVaults.includes(to)) {
  deny("contract target is not allowlisted");
  process.exit(0);
}

if (selector !== config.depositSelector && selector !== config.withdrawSelector) {
  deny("function selector is not allowlisted");
  process.exit(0);
}

const amount = parseUintWord(data, 0);
if (amount === null || amount > config.maxTurnoverUnits) {
  deny("transaction amount exceeds the configured turnover cap");
  process.exit(0);
}

allow();
`;
    const policyJson = {
        id: policyId,
        name: `Morpho Vault Manager ${params.profileId}`,
        version: 1,
        created_at: new Date().toISOString(),
        rules: [
            {
                type: "allowed_chains",
                chain_ids: [BASE_CHAIN_ID]
            }
        ],
        executable: executablePath,
        config: null,
        action: "deny"
    };
    await writeTextFile(executablePath, executableContent);
    await chmod(executablePath, 0o755);
    await writeJsonFile(policyFilePath, policyJson);
    return {
        policyId,
        executablePath,
        policyFilePath
    };
}
