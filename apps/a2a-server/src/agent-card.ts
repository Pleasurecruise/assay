import type { AgentCard } from "@a2a-js/sdk";
import { AUDIT_REQUEST_SCHEMA_VERSION } from "@assay/contracts";

export const A2A_SERVER_VERSION = "0.1.0";
export const A2A_BEARER_SECURITY_SCHEME = "assayBearer";

export interface AssayAgentCardOptions {
  bearerAuthentication?: boolean;
}

export function createAssayAgentCard(
  restUrl: string,
  jsonRpcUrl: string,
  options: AssayAgentCardOptions = {},
): AgentCard {
  const securitySchemes: AgentCard["securitySchemes"] =
    options.bearerAuthentication === true
      ? {
          [A2A_BEARER_SECURITY_SCHEME]: {
            scheme: {
              $case: "httpAuthSecurityScheme",
              value: {
                description: "Opaque bearer token supplied by the Assay operator.",
                scheme: "Bearer",
                bearerFormat: "opaque",
              },
            },
          },
        }
      : {};
  const securityRequirements: AgentCard["securityRequirements"] =
    options.bearerAuthentication === true
      ? [
          {
            schemes: {
              [A2A_BEARER_SECURITY_SCHEME]: { list: [] },
            },
          },
        ]
      : [];

  return {
    name: "Assay Strategy Audit",
    description:
      "Audits supported index-universe ranking strategies with five independent robustness checks. Outputs are technical audits, not investment advice.",
    supportedInterfaces: [
      createTenantlessInterface(restUrl, "HTTP+JSON"),
      createTenantlessInterface(jsonRpcUrl, "JSONRPC"),
    ],
    provider: undefined,
    version: A2A_SERVER_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [],
    },
    securitySchemes,
    securityRequirements,
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json", "text/markdown"],
    skills: [
      {
        id: "audit_strategy",
        name: "Audit Strategy",
        description:
          "Skeleton accepts natural-language text with an index universe, library or built-in template signal, top-N selection, weekly or monthly rebalance, and required historical dates. " +
          `The request schema is ${AUDIT_REQUEST_SCHEMA_VERSION}; output is application/json plus text/markdown. ` +
          "Missing or unsupported input completes with an UNVERIFIABLE Artifact; complete input is validated, frozen, and sent to five independent checks. This is a technical audit, not investment advice.",
        tags: ["strategy", "audit", "robustness"],
        examples: ["Audit a CSI 300 monthly momentum strategy from 2021-01-01 to 2025-12-31."],
        inputModes: ["text/plain"],
        outputModes: ["application/json", "text/markdown"],
        securityRequirements,
      },
    ],
    signatures: [],
  };
}

function createTenantlessInterface(
  url: string,
  protocolBinding: "HTTP+JSON" | "JSONRPC",
): AgentCard["supportedInterfaces"][number] {
  // @a2a-js/sdk 1.0 models the protobuf default as a required string, while
  // the JSON wire field is optional. Emitting tenant: "" is rejected by
  // strict Agent Card validators, so omit it for this single-tenant service.
  return {
    url,
    protocolBinding,
    protocolVersion: "1.0",
  } as AgentCard["supportedInterfaces"][number];
}
