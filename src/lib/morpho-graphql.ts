import { getAddress } from "viem";

const DEFAULT_ENDPOINT = "https://api.morpho.org/graphql";
const BASE_CHAIN_ID_NUM = 8453;

export type MorphoGraphqlMarket = {
  uniqueKey: string;
  lltv: string;
  loanAsset: { address: string; symbol: string; decimals: number };
  collateralAsset: { address: string; symbol: string; decimals: number } | null;
};

export type MorphoGraphqlAllocation = {
  market: MorphoGraphqlMarket;
  supplyAssets: string;
  supplyAssetsUsd: number;
  supplyCap: string;
};

export type MorphoGraphqlVaultPosition = {
  assets: string;
  assetsUsd: number;
  shares: string;
  vault: {
    address: string;
    name: string;
    symbol: string;
    asset: { address: string; symbol: string; decimals: number };
    state: {
      totalAssets: string;
      totalAssetsUsd: number;
      apy: number;
      netApy: number;
      allocation: MorphoGraphqlAllocation[];
    } | null;
  };
};

export type MorphoGraphqlUserPositions = {
  endpoint: string;
  chainId: number;
  userAddress: string;
  totalSuppliedUsd: number;
  vaultPositions: MorphoGraphqlVaultPosition[];
};

export type FetchUserPositionsOptions = {
  chainId?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const USER_POSITIONS_QUERY = /* GraphQL */ `
  query UserPositions($address: String!, $chainId: Int!) {
    userByAddress(address: $address, chainId: $chainId) {
      address
      vaultPositions {
        assets
        assetsUsd
        shares
        vault {
          address
          name
          symbol
          asset { address symbol decimals }
          state {
            totalAssets
            totalAssetsUsd
            apy
            netApy
            allocation {
              supplyAssets
              supplyAssetsUsd
              supplyCap
              market {
                uniqueKey
                lltv
                loanAsset { address symbol decimals }
                collateralAsset { address symbol decimals }
              }
            }
          }
        }
      }
    }
  }
`;

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
};

type RawAsset = {
  address?: unknown;
  symbol?: unknown;
  decimals?: unknown;
};

type RawMarket = {
  uniqueKey?: unknown;
  lltv?: unknown;
  loanAsset?: RawAsset | null;
  collateralAsset?: RawAsset | null;
};

type RawAllocation = {
  market?: RawMarket | null;
  supplyAssets?: unknown;
  supplyAssetsUsd?: unknown;
  supplyCap?: unknown;
};

type RawVaultState = {
  totalAssets?: unknown;
  totalAssetsUsd?: unknown;
  apy?: unknown;
  netApy?: unknown;
  allocation?: RawAllocation[] | null;
};

type RawVaultPosition = {
  assets?: unknown;
  assetsUsd?: unknown;
  shares?: unknown;
  vault?: {
    address?: unknown;
    name?: unknown;
    symbol?: unknown;
    asset?: RawAsset | null;
    state?: RawVaultState | null;
  } | null;
};

type RawUserResponse = {
  userByAddress?: {
    address?: unknown;
    vaultPositions?: RawVaultPosition[] | null;
  } | null;
};

function toNum(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value.toString();
  if (typeof value === "bigint") return value.toString();
  return fallback;
}

function normalizeAsset(raw: RawAsset | null | undefined): {
  address: string;
  symbol: string;
  decimals: number;
} {
  const address = toStr(raw?.address);
  return {
    address: address ? getAddress(address) : "",
    symbol: toStr(raw?.symbol),
    decimals: typeof raw?.decimals === "number" ? raw.decimals : 0
  };
}

function normalizeAllocation(raw: RawAllocation): MorphoGraphqlAllocation | null {
  const market = raw.market;
  if (!market || typeof market.uniqueKey !== "string") return null;

  return {
    market: {
      uniqueKey: market.uniqueKey,
      lltv: toStr(market.lltv, "0"),
      loanAsset: normalizeAsset(market.loanAsset ?? undefined),
      collateralAsset: market.collateralAsset ? normalizeAsset(market.collateralAsset) : null
    },
    supplyAssets: toStr(raw.supplyAssets, "0"),
    supplyAssetsUsd: toNum(raw.supplyAssetsUsd),
    supplyCap: toStr(raw.supplyCap, "0")
  };
}

function normalizeVaultPosition(raw: RawVaultPosition): MorphoGraphqlVaultPosition | null {
  const vault = raw.vault;
  if (!vault || typeof vault.address !== "string") return null;

  const state = vault.state ?? null;
  const allocationList: MorphoGraphqlAllocation[] = Array.isArray(state?.allocation)
    ? (state!.allocation as RawAllocation[])
        .map(normalizeAllocation)
        .filter((a): a is MorphoGraphqlAllocation => a !== null)
    : [];

  return {
    assets: toStr(raw.assets, "0"),
    assetsUsd: toNum(raw.assetsUsd),
    shares: toStr(raw.shares, "0"),
    vault: {
      address: getAddress(vault.address),
      name: toStr(vault.name),
      symbol: toStr(vault.symbol),
      asset: normalizeAsset(vault.asset ?? undefined),
      state: state
        ? {
            totalAssets: toStr(state.totalAssets, "0"),
            totalAssetsUsd: toNum(state.totalAssetsUsd),
            apy: toNum(state.apy),
            netApy: toNum(state.netApy),
            allocation: allocationList
          }
        : null
    }
  };
}

export async function fetchUserPositions(
  userAddress: string,
  opts: FetchUserPositionsOptions = {}
): Promise<MorphoGraphqlUserPositions> {
  const chainId = opts.chainId ?? BASE_CHAIN_ID_NUM;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const address = getAddress(userAddress);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        query: USER_POSITIONS_QUERY,
        variables: { address, chainId }
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Morpho GraphQL request failed: ${message}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Morpho GraphQL HTTP ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }

  const payload = (await response.json()) as GraphqlResponse<RawUserResponse>;
  if (payload.errors && payload.errors.length > 0) {
    const onlyNoResults = payload.errors.every((e) =>
      /no results matching given parameters/i.test(e.message)
    );
    if (!onlyNoResults) {
      const joined = payload.errors.map((e) => e.message).join("; ");
      throw new Error(`Morpho GraphQL returned errors: ${joined}`);
    }
  }

  const rawPositions = payload.data?.userByAddress?.vaultPositions ?? [];
  const vaultPositions = rawPositions
    .map(normalizeVaultPosition)
    .filter((p): p is MorphoGraphqlVaultPosition => p !== null);

  const totalSuppliedUsd = vaultPositions.reduce((acc, p) => acc + p.assetsUsd, 0);

  return {
    endpoint,
    chainId,
    userAddress: address,
    totalSuppliedUsd,
    vaultPositions
  };
}
