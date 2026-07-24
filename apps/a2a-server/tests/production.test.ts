import { describe, expect, test } from "vitest";
import { DEFAULT_ASSAY_A2A_CORS_ORIGIN, readProductionConfig } from "../src/configuration";

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

  test("defaults the browser origin and accepts an explicit HTTP origin", () => {
    expect(readProductionConfig(BASE_ENVIRONMENT).corsOrigin).toBe(DEFAULT_ASSAY_A2A_CORS_ORIGIN);
    expect(
      readProductionConfig({
        ...BASE_ENVIRONMENT,
        ASSAY_A2A_CORS_ORIGIN: "https://assay.example.com:8443/",
      }).corsOrigin,
    ).toBe("https://assay.example.com:8443");
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
