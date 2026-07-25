import {
  AUDIT_CHECK_SUBMISSION_TOOL_NAME,
  type AgentTool,
} from "@assay/agent-runtime";
import { CHECK_CONCLUSIONS, type AuditCheckId } from "@assay/contracts";

const AGENT_CHECK_CONCLUSIONS = CHECK_CONCLUSIONS.filter(
  (conclusion) => conclusion !== "not_applicable",
);

export function createSubmitAuditCheckResultTool(checkId: AuditCheckId): AgentTool {
  return {
    name: AUDIT_CHECK_SUBMISSION_TOOL_NAME,
    label: "Submit final audit check result",
    description:
      "Submit the one final frozen-schema audit result after the approved evidence tool completes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "conclusion", "confidence", "evidence", "missingEvidence"],
      properties: {
        id: { type: "string", enum: [checkId] },
        conclusion: { type: "string", enum: AGENT_CHECK_CONCLUSIONS },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        evidence: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["metric", "value", "unit", "sourceRefs"],
            properties: {
              metric: { type: "string", minLength: 1 },
              value: {
                anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }],
              },
              unit: { type: "string", minLength: 1 },
              sourceRefs: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
        missingEvidence: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["requirement", "reason", "sourceRefs"],
            properties: {
              requirement: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
              sourceRefs: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    strict: true,
    approval: "read",
    intent: "omit",
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: "Final audit result accepted. End the task without emitting another result.",
          },
        ],
        details: { accepted: true },
      };
    },
  };
}
