import { runCommand } from "./shell.js";
import type { VaultManagerSettings } from "./types.js";

type OwsSignTxPayload = {
  signature?: string;
  signedTransaction?: string;
  transactionHash?: string;
};

export function buildWalletCreateCommand(settings: VaultManagerSettings, walletName: string): string {
  return `${settings.owsCommand} wallet create --name "${walletName}"`;
}

export function buildApiKeyCreateCommand(params: {
  settings: VaultManagerSettings;
  keyName: string;
  walletRef: string;
}): string {
  return `${params.settings.owsCommand} key create --name "${params.keyName}" --wallet "${params.walletRef}"`;
}

function normalizeHexString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function extractHexPayload(value: unknown): OwsSignTxPayload {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  const nested = typeof record.result === "object" ? extractHexPayload(record.result) : {};

  return {
    signature:
      normalizeHexString(record.signature) ??
      normalizeHexString(record.signatureHex) ??
      nested.signature,
    signedTransaction:
      normalizeHexString(record.signedTransaction) ??
      normalizeHexString(record.signedTransactionHex) ??
      normalizeHexString(record.rawTransaction) ??
      normalizeHexString(record.transactionHex) ??
      normalizeHexString(record.tx) ??
      nested.signedTransaction,
    transactionHash:
      normalizeHexString(record.transactionHash) ??
      normalizeHexString(record.hash) ??
      nested.transactionHash
  };
}

function parseOwsSignTxPayload(stdout: string): OwsSignTxPayload {
  const text = stdout.trim();
  if (!text) {
    return {};
  }

  try {
    return extractHexPayload(JSON.parse(text));
  } catch {
    const hex = normalizeHexString(text);
    if (!hex) return {};
    if (hex.length === 66) return { transactionHash: hex };
    if (hex.length === 132) return { signature: hex };
    return { signedTransaction: hex };
  }
}

export async function signTransactionWithOws(params: {
  settings: VaultManagerSettings;
  walletRef: string;
  token: string;
  chain: "base";
  unsignedTransactionHex: string;
}): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  payload: OwsSignTxPayload;
  error?: string;
}> {
  const token = params.token;
  if (!token) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      payload: {},
      error: "No OWS API token was resolved before calling sign."
    };
  }

  const result = await runCommand(
    params.settings.owsCommand,
    [
      "sign",
      "tx",
      "--wallet",
      params.walletRef,
      "--chain",
      params.chain,
      "--tx",
      params.unsignedTransactionHex,
      "--json"
    ],
    {
      env: {
        ...process.env,
        OWS_PASSPHRASE: token
      }
    }
  );

  const payload = parseOwsSignTxPayload(result.stdout);
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    payload,
    error: result.code === 0 ? undefined : result.stderr.trim() || result.stdout.trim() || "OWS sign tx failed."
  };
}
