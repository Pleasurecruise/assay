import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_ASSAY_A2A_CORS_ORIGINS, readProductionConfig } from "../src/configuration";

const BASE_ENVIRONMENT: NodeJS.ProcessEnv = {
  ARK_API_KEY: "test-key",
  ARK_MODEL_DEEPSEEK: "ep-test-deepseek",
  ASSAY_DATA_AS_OF: "2026-07-24",
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-thirty-two-characters",
  GOOGLE_CLIENT_ID: "google-test-client-id",
  GOOGLE_CLIENT_SECRET: "google-test-client-secret",
};

describe("readProductionConfig", () => {
  test("requires the Ark DeepSeek endpoint id", () => {
    const environment = { ...BASE_ENVIRONMENT };
    delete environment.ARK_MODEL_DEEPSEEK;

    expect(() => readProductionConfig(environment)).toThrow("ARK_MODEL_DEEPSEEK is required");
  });

  test("uses the explicitly configured Ark DeepSeek endpoint id", () => {
    expect(readProductionConfig(BASE_ENVIRONMENT).arkModel).toBe("ep-test-deepseek");
  });

  test("configures Google auth and a local SQLite database", () => {
    const config = readProductionConfig(BASE_ENVIRONMENT);

    expect(config.authBaseUrl).toBe("http://localhost:5173");
    expect(config.databasePath).toBe("data/assay.sqlite");
    expect(config.googleClientId).toBe("google-test-client-id");
    expect(config.localDataPackageRoot).toBe(resolve(".cache/assay"));
    expect(config.auditOutputRoot).toBe(resolve(".cache/assay/audit-output"));
  });

  test("accepts explicit local package and derived runtime data roots", () => {
    const config = readProductionConfig({
      ...BASE_ENVIRONMENT,
      ASSAY_LOCAL_DATA_PACKAGE_ROOT: "./tmp/local-packages",
      ASSAY_AUDIT_OUTPUT_ROOT: "./tmp/audit-output",
    });

    expect(config.localDataPackageRoot).toBe(resolve("./tmp/local-packages"));
    expect(config.auditOutputRoot).toBe(resolve("./tmp/audit-output"));
  });

  test("rejects a short Better Auth secret", () => {
    expect(() =>
      readProductionConfig({
        ...BASE_ENVIRONMENT,
        BETTER_AUTH_SECRET: "too-short",
      }),
    ).toThrow("BETTER_AUTH_SECRET must contain at least 32 characters");
  });

  test("accepts an optional A2A bearer token without exposing a default", () => {
    expect(readProductionConfig(BASE_ENVIRONMENT).a2aBearerToken).toBeUndefined();
    expect(
      readProductionConfig({
        ...BASE_ENVIRONMENT,
        ASSAY_A2A_BEARER_TOKEN: "test-a2a-token-that-is-at-least-thirty-two-characters",
      }).a2aBearerToken,
    ).toBe("test-a2a-token-that-is-at-least-thirty-two-characters");
  });

  test("rejects a short A2A bearer token", () => {
    expect(() =>
      readProductionConfig({
        ...BASE_ENVIRONMENT,
        ASSAY_A2A_BEARER_TOKEN: "too-short",
      }),
    ).toThrow("ASSAY_A2A_BEARER_TOKEN must contain at least 32 characters");
  });

  test("accepts a deduplicated supplemental Ark credential pool", () => {
    const config = readProductionConfig({
      ...BASE_ENVIRONMENT,
      ARK_API_KEYS: "second-key, third-key, second-key",
    });

    expect(config.arkApiKey).toBe("test-key");
    expect(config.arkApiKeys).toEqual(["second-key", "third-key"]);
  });

  test("requires a fixed data snapshot date", () => {
    const environment = { ...BASE_ENVIRONMENT };
    delete environment.ASSAY_DATA_AS_OF;

    expect(() => readProductionConfig(environment)).toThrow("ASSAY_DATA_AS_OF is required");
  });

  test("defaults the browser origins and accepts a comma-separated allowlist", () => {
    expect(readProductionConfig(BASE_ENVIRONMENT).corsOrigins).toEqual(
      DEFAULT_ASSAY_A2A_CORS_ORIGINS,
    );
    expect(
      readProductionConfig({
        ...BASE_ENVIRONMENT,
        ASSAY_A2A_CORS_ORIGIN:
          "https://assay.example.com:8443/, http://100.102.132.89:5173, https://assay.example.com:8443",
      }).corsOrigins,
    ).toEqual(["https://assay.example.com:8443", "http://100.102.132.89:5173"]);
  });

  test("rejects a CORS value that is a URL rather than an origin", () => {
    expect(() =>
      readProductionConfig({
        ...BASE_ENVIRONMENT,
        ASSAY_A2A_CORS_ORIGIN: "https://assay.example.com/app",
      }),
    ).toThrow("ASSAY_A2A_CORS_ORIGIN must contain only scheme, host, and optional port");
  });
});
