const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_ASSAY_A2A_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

export interface ProductionA2AConfig {
  arkApiKey: string;
  arkApiKeys?: readonly string[];
  arkBaseUrl: string;
  arkModel: string;
  dataAsOf: string;
  capabilitySnapshotId: string;
  codeRevision: string;
  publicUrl: string;
  corsOrigins: readonly string[];
  pandaDataConfigured: boolean;
}

function optionalCredentialPool(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function requireDate(value: string, name: string): string {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function requireHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return value.replace(/\/+$/, "");
}

function requireHttpOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${name} must contain only scheme, host, and optional port`);
  }
  return url.origin;
}

function requireHttpOrigins(value: string, name: string): readonly string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => requireHttpOrigin(origin, name));
  if (origins.length === 0) {
    throw new Error(`${name} must contain at least one HTTP(S) origin`);
  }
  return [...new Set(origins)];
}

export function readProductionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProductionA2AConfig {
  const arkBaseUrl = environment.ARK_BASE_URL?.trim() || DEFAULT_ARK_BASE_URL;
  const dataAsOf = environment.ASSAY_DATA_AS_OF?.trim() || utcDate();
  const listenPort = environment.ASSAY_A2A_PORT?.trim() || "3001";
  const publicUrl = environment.ASSAY_A2A_PUBLIC_URL?.trim() || `http://127.0.0.1:${listenPort}`;
  const corsOrigins =
    environment.ASSAY_A2A_CORS_ORIGIN?.trim() || DEFAULT_ASSAY_A2A_CORS_ORIGINS.join(",");
  return {
    arkApiKey: requireNonEmpty(environment.ARK_API_KEY, "ARK_API_KEY"),
    arkApiKeys: optionalCredentialPool(environment.ARK_API_KEYS),
    arkBaseUrl: requireHttpUrl(arkBaseUrl, "ARK_BASE_URL"),
    arkModel: requireNonEmpty(environment.ARK_MODEL_DEEPSEEK, "ARK_MODEL_DEEPSEEK"),
    dataAsOf: requireDate(dataAsOf, "ASSAY_DATA_AS_OF"),
    capabilitySnapshotId:
      environment.ASSAY_CAPABILITY_SNAPSHOT_ID?.trim() || "pandadata:toolset-v1",
    codeRevision: environment.ASSAY_CODE_REVISION?.trim() || "development",
    publicUrl: requireHttpUrl(publicUrl, "ASSAY_A2A_PUBLIC_URL"),
    corsOrigins: requireHttpOrigins(corsOrigins, "ASSAY_A2A_CORS_ORIGIN"),
    pandaDataConfigured:
      Boolean(environment.PANDA_DATA_USERNAME?.trim()) && Boolean(environment.PANDA_DATA_PASSWORD),
  };
}
