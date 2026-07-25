import { resolve } from "node:path";
import { LOCAL_DATA_RUNTIME_ROOT } from "./local-data-package";

const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_AUDIT_OUTPUT_ROOT = ".cache/assay/audit-output";
export const DEFAULT_ASSAY_A2A_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

export interface ProductionA2AConfig {
  a2aBearerToken?: string;
  arkApiKey: string;
  arkBaseUrl: string;
  arkModel: string;
  authBaseUrl?: string;
  betterAuthSecret?: string;
  dataAsOf: string;
  databasePath?: string;
  capabilitySnapshotId: string;
  codeRevision: string;
  publicUrl: string;
  corsOrigins: readonly string[];
  localDataPackageRoot: string;
  auditOutputRoot: string;
  googleClientId?: string;
  googleClientSecret?: string;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function requireAuthSecret(value: string | undefined): string {
  const secret = requireNonEmpty(value, "BETTER_AUTH_SECRET");
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }
  return secret;
}

function optionalBearerToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (token === undefined || token.length === 0) {
    return undefined;
  }
  if (token.length < 32) {
    throw new Error("ASSAY_A2A_BEARER_TOKEN must contain at least 32 characters");
  }
  return token;
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
  const dataAsOf = requireNonEmpty(environment.ASSAY_DATA_AS_OF, "ASSAY_DATA_AS_OF");
  const listenPort = environment.ASSAY_A2A_PORT?.trim() || "3001";
  const publicUrl = environment.ASSAY_A2A_PUBLIC_URL?.trim() || `http://127.0.0.1:${listenPort}`;
  const corsOrigins =
    environment.ASSAY_A2A_CORS_ORIGIN?.trim() || DEFAULT_ASSAY_A2A_CORS_ORIGINS.join(",");
  const parsedCorsOrigins = requireHttpOrigins(corsOrigins, "ASSAY_A2A_CORS_ORIGIN");
  const authBaseUrl = environment.ASSAY_AUTH_BASE_URL?.trim() || parsedCorsOrigins[0];
  if (authBaseUrl === undefined) {
    throw new Error("ASSAY_AUTH_BASE_URL is required");
  }
  return {
    a2aBearerToken: optionalBearerToken(environment.ASSAY_A2A_BEARER_TOKEN),
    arkApiKey: requireNonEmpty(environment.ARK_API_KEY, "ARK_API_KEY"),
    arkBaseUrl: requireHttpUrl(arkBaseUrl, "ARK_BASE_URL"),
    arkModel: requireNonEmpty(environment.ARK_MODEL_DEEPSEEK, "ARK_MODEL_DEEPSEEK"),
    authBaseUrl: requireHttpOrigin(authBaseUrl, "ASSAY_AUTH_BASE_URL"),
    betterAuthSecret: requireAuthSecret(environment.BETTER_AUTH_SECRET),
    dataAsOf: requireDate(dataAsOf, "ASSAY_DATA_AS_OF"),
    databasePath: environment.ASSAY_DATABASE_PATH?.trim() || "data/assay.sqlite",
    capabilitySnapshotId:
      environment.ASSAY_CAPABILITY_SNAPSHOT_ID?.trim() || "local-data-package:registry",
    codeRevision: environment.ASSAY_CODE_REVISION?.trim() || "development",
    publicUrl: requireHttpUrl(publicUrl, "ASSAY_A2A_PUBLIC_URL"),
    corsOrigins: parsedCorsOrigins,
    localDataPackageRoot: resolve(
      environment.ASSAY_LOCAL_DATA_PACKAGE_ROOT?.trim() || LOCAL_DATA_RUNTIME_ROOT,
    ),
    auditOutputRoot: resolve(
      environment.ASSAY_AUDIT_OUTPUT_ROOT?.trim() || DEFAULT_AUDIT_OUTPUT_ROOT,
    ),
    googleClientId: requireNonEmpty(environment.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
    googleClientSecret: requireNonEmpty(environment.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
  };
}
