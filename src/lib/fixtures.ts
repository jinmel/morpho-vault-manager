import { getAddress } from "viem";
import { BASE_USDC_ADDRESS } from "./constants.js";
import type {
  MorphoPositionsResponse,
  MorphoTokenBalanceResponse,
  MorphoVaultDetail,
  MorphoVaultPosition
} from "./morpho.js";
import type { PlanReadDeps } from "./rebalance.js";

export type FixtureVault = {
  address: string;
  name: string;
  apyPct: string;
  feePct: string;
  tvlUsd: string;
};

export type FixturePosition = {
  vaultAddress: string;
  vaultName: string;
  suppliedUsdc: string;
};

export const FIXTURE_WALLET = getAddress("0x1111111111111111111111111111111111111111");

export const FIXTURE_VAULT_A: FixtureVault = {
  address: getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  name: "USDC Vault A",
  apyPct: "0.06",
  feePct: "0.05",
  tvlUsd: "50000000"
};

export const FIXTURE_VAULT_B: FixtureVault = {
  address: getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  name: "USDC Vault B",
  apyPct: "0.045",
  feePct: "0.05",
  tvlUsd: "20000000"
};

export function fixtureVaultDetail(vault: FixtureVault): MorphoVaultDetail {
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

export function fixturePositionsResponse(
  walletAddress: string,
  positions: FixturePosition[]
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

export function fixtureTokenBalance(walletAddress: string, amount: string): MorphoTokenBalanceResponse {
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

export type FixtureSandboxInputs = {
  walletAddress?: string;
  vaults?: FixtureVault[];
  positions?: FixturePosition[];
  idleUsdc?: string;
};

export function makeFixturePlanDeps(inputs: FixtureSandboxInputs = {}): PlanReadDeps {
  const walletAddress = inputs.walletAddress ?? FIXTURE_WALLET;
  const vaults = inputs.vaults ?? [FIXTURE_VAULT_A, FIXTURE_VAULT_B];
  const positions = inputs.positions ?? [];
  const idleUsdc = inputs.idleUsdc ?? "5000";
  const vaultDetails = vaults.map(fixtureVaultDetail);

  return {
    queryVaults: async () => vaultDetails,
    getPositions: async () => fixturePositionsResponse(walletAddress, positions),
    getTokenBalance: async () => fixtureTokenBalance(walletAddress, idleUsdc)
  };
}
