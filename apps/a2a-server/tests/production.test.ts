import { describe, expect, test } from "vitest";
import { DEFAULT_ASSAY_A2A_CORS_ORIGINS, readProductionConfig } from "../src/configuration";

const BASE_ENVIRONMENT: NodeJS.ProcessEnv = {
  ARK_API_KEY: "test-key",
  ARK_MODEL_DEEPSEEK: "ep-test-deepseek",
  ASSAY_DATA_AS_OF: "2026-07-24",
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

  test("reports PandaData readiness without retaining credential values", () => {
    const config = readProductionConfig({
      ...BASE_ENVIRONMENT,
      PANDA_DATA_USERNAME: "86+13800000000",
      PANDA_DATA_PASSWORD: "test-password",
    });

    expect(config.pandaDataConfigured).toBe(true);
    expect(config).not.toHaveProperty("pandaDataUsername");
    expect(config).not.toHaveProperty("pandaDataPassword");
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
