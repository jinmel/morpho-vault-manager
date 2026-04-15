import { getAddress } from "viem";
import { BASE_USDC_ADDRESS } from "./constants.js";
export const FIXTURE_WALLET = getAddress("0x1111111111111111111111111111111111111111");
export const FIXTURE_VAULT_A = {
    address: getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    name: "USDC Vault A",
    apyPct: "0.06",
    feePct: "0.05",
    tvlUsd: "50000000"
};
export const FIXTURE_VAULT_B = {
    address: getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    name: "USDC Vault B",
    apyPct: "0.045",
    feePct: "0.05",
    tvlUsd: "20000000"
};
export function fixtureVaultDetail(vault) {
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
export function fixturePositionsResponse(walletAddress, positions) {
    const vaultPositions = positions.map((position) => ({
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
export function fixtureTokenBalance(walletAddress, amount) {
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
export function fixturePreparedOperation(params) {
    const succeed = params.succeed ?? true;
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
        simulationOk: succeed,
        warnings: succeed ? [] : [{ level: "error", message: "Simulation failed (fixture)." }]
    };
}
export function makeFixtureRebalanceDeps(inputs = {}) {
    const walletAddress = inputs.walletAddress ?? FIXTURE_WALLET;
    const vaults = inputs.vaults ?? [FIXTURE_VAULT_A, FIXTURE_VAULT_B];
    const positions = inputs.positions ?? [];
    const idleUsdc = inputs.idleUsdc ?? "5000";
    const simulationFails = inputs.simulationFails ?? false;
    const vaultMap = new Map(vaults.map((vault) => [vault.address, fixtureVaultDetail(vault)]));
    return {
        getVault: async (address) => {
            const vault = vaultMap.get(getAddress(address));
            if (!vault)
                throw new Error(`Fixture missing vault ${address}`);
            return vault;
        },
        getPositions: async () => fixturePositionsResponse(walletAddress, positions),
        getTokenBalance: async () => fixtureTokenBalance(walletAddress, idleUsdc),
        prepareDeposit: async (vaultAddress, _walletAddress, amount) => fixturePreparedOperation({
            kind: "deposit",
            vaultAddress,
            amount,
            succeed: !simulationFails
        }),
        prepareWithdraw: async (vaultAddress, _walletAddress, amount) => fixturePreparedOperation({
            kind: "withdraw",
            vaultAddress,
            amount,
            succeed: !simulationFails
        })
    };
}
