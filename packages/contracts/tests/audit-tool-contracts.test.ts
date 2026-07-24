import {
  AUDIT_TOOL_CONTRACT_VERSION,
  HOMOGENEITY_COMPARATORS,
  RUN_AVAILABILITY_AUDIT_REQUEST_SCHEMA,
  RUN_AVAILABILITY_AUDIT_RESPONSE_SCHEMA,
  RUN_HOMOGENEITY_REQUEST_SCHEMA,
  RUN_HOMOGENEITY_RESPONSE_SCHEMA,
  RUN_REGIME_SPLIT_REQUEST_SCHEMA,
  RUN_REGIME_SPLIT_RESPONSE_SCHEMA,
} from "../src";
import { describe, expect, test } from "vitest";

describe("frozen audit tool contracts", () => {
  test.each([
    RUN_AVAILABILITY_AUDIT_REQUEST_SCHEMA,
    RUN_AVAILABILITY_AUDIT_RESPONSE_SCHEMA,
    RUN_REGIME_SPLIT_REQUEST_SCHEMA,
    RUN_REGIME_SPLIT_RESPONSE_SCHEMA,
    RUN_HOMOGENEITY_REQUEST_SCHEMA,
    RUN_HOMOGENEITY_RESPONSE_SCHEMA,
  ])("$id is strict and versioned", (schema) => {
    expect(schema.$id).toMatch(/^assay:\/\/schemas\/.+-v1$/);
    expect(schema.additionalProperties).toBe(false);
  });

  test("freezes one host-bound request shape for each deterministic tool", () => {
    expect(RUN_AVAILABILITY_AUDIT_REQUEST_SCHEMA.required).toEqual(["kind", "spec", "budget"]);
    expect(RUN_REGIME_SPLIT_REQUEST_SCHEMA.properties.kind.const).toBe("regime_split");
    expect(RUN_HOMOGENEITY_REQUEST_SCHEMA.properties.kind.const).toBe("homogeneity");
    expect(
      RUN_AVAILABILITY_AUDIT_REQUEST_SCHEMA.properties.budget.properties.maxVariants.const,
    ).toBe(1);
  });

  test("freezes the CHECKS_WIRING response evidence fields", () => {
    expect(RUN_AVAILABILITY_AUDIT_RESPONSE_SCHEMA.required).toContain("corrected");
    expect(RUN_REGIME_SPLIT_RESPONSE_SCHEMA.required).toContain("environments");
    expect(RUN_HOMOGENEITY_RESPONSE_SCHEMA.required).toContain("annualIc");
    expect(
      RUN_HOMOGENEITY_RESPONSE_SCHEMA.properties.comparisons.items.properties.comparator.enum,
    ).toEqual(HOMOGENEITY_COMPARATORS);
    expect(RUN_HOMOGENEITY_RESPONSE_SCHEMA.properties.contractVersion.const).toBe(
      AUDIT_TOOL_CONTRACT_VERSION,
    );
  });
});
