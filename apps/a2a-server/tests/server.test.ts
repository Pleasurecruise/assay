import type { AgentExecutor } from "@a2a-js/sdk/server";
import { afterEach, describe, expect, test } from "vitest";
import type { Server } from "node:http";
import { createAssayAuth } from "../src/auth";
import { AssayDatabase } from "../src/database";
import { ASSAY_A2A_JSON_RPC_PATH, ASSAY_A2A_REST_PATH, createAssayA2AApp } from "../src/server";

let server: Server | undefined;
let database: AssayDatabase | undefined;

afterEach(
  () =>
    new Promise<void>((resolve, reject) => {
      if (server === undefined) {
        database?.close();
        database = undefined;
        resolve();
        return;
      }
      server.close((error) => {
        server = undefined;
        database?.close();
        database = undefined;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    }),
);

describe("Assay A2A transports", () => {
  test("returns the A2A NOT_FOUND shape for an unknown REST task", async () => {
    const executor: AgentExecutor = {
      execute: async () => {
        throw new Error("task lookup must not execute an audit");
      },
      cancelTask: async () => {
        throw new Error("task lookup must not cancel an audit");
      },
    };
    const service = createAssayA2AApp({ executor });
    server = service.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }

    const response = await fetch(
      `http://127.0.0.1:${String(address.port)}${ASSAY_A2A_REST_PATH}/tasks/missing-task`,
      { headers: { "A2A-Version": "1.0" } },
    );
    const payload = (await response.json()) as {
      error?: { code?: number; status?: string; message?: string };
    };

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/a2a+json");
    expect(payload.error).toEqual(
      expect.objectContaining({
        code: 404,
        status: "NOT_FOUND",
        message: "Task not found: missing-task",
      }),
    );
  });

  test("protects both A2A transports with an optional bearer token", async () => {
    const executor: AgentExecutor = {
      execute: async () => {
        throw new Error("task lookup must not execute an audit");
      },
      cancelTask: async () => {
        throw new Error("task lookup must not cancel an audit");
      },
    };
    const token = "test-a2a-token-that-is-at-least-thirty-two-characters";
    const service = createAssayA2AApp({ executor, a2aBearerToken: token });
    server = service.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const jsonRpcBody = {
      jsonrpc: "2.0",
      id: "assay-bearer-handshake",
      method: "tasks/get",
      params: { id: "missing-task" },
    };

    const [cardResponse, unauthenticatedRest, unauthenticatedJsonRpc, authenticatedJsonRpc] =
      await Promise.all([
        fetch(`${origin}/.well-known/agent-card.json`),
        fetch(`${origin}${ASSAY_A2A_REST_PATH}/tasks/missing`),
        fetch(`${origin}${ASSAY_A2A_JSON_RPC_PATH}`, {
          method: "POST",
          headers: {
            "A2A-Version": "1.0",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(jsonRpcBody),
        }),
        fetch(`${origin}${ASSAY_A2A_JSON_RPC_PATH}`, {
          method: "POST",
          headers: {
            "A2A-Version": "1.0",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(jsonRpcBody),
        }),
      ]);
    const card = (await cardResponse.json()) as {
      supportedInterfaces?: Array<Record<string, unknown>>;
      securitySchemes?: Record<string, unknown>;
      securityRequirements?: unknown[];
    };
    const authenticatedPayload = (await authenticatedJsonRpc.json()) as {
      jsonrpc?: string;
      id?: string;
    };

    expect(cardResponse.status).toBe(200);
    expect(cardResponse.headers.get("cache-control")).toBe("no-cache");
    expect(
      card.supportedInterfaces?.every((agentInterface) => !Object.hasOwn(agentInterface, "tenant")),
    ).toBe(true);
    expect(card.securitySchemes).toHaveProperty("assayBearer");
    expect(card.securityRequirements).toHaveLength(1);
    expect(unauthenticatedRest.status).toBe(401);
    expect(unauthenticatedRest.headers.get("www-authenticate")).toBe('Bearer realm="assay-a2a"');
    expect(unauthenticatedJsonRpc.status).toBe(401);
    expect(authenticatedJsonRpc.status).toBe(200);
    expect(authenticatedPayload.jsonrpc).toBe("2.0");
    expect(authenticatedPayload.id).toBe("assay-bearer-handshake");
  });

  test("keeps A2A public while Better Auth protects private user routes", async () => {
    const executor: AgentExecutor = {
      execute: async () => {
        throw new Error("unauthenticated requests must not execute an audit");
      },
      cancelTask: async () => {
        throw new Error("unauthenticated requests must not cancel an audit");
      },
    };
    database = new AssayDatabase(":memory:");
    const authService = createAssayAuth(
      {
        baseUrl: "http://localhost:5173",
        secret: "test-secret-that-is-at-least-thirty-two-characters",
        trustedOrigins: ["http://localhost:5173"],
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
      },
      database,
    );
    await authService.initialize();
    const service = createAssayA2AApp({ executor, authService, database });
    server = service.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${String(address.port)}`;

    const [authHealth, auditHistory, restA2a, jsonRpcA2a] = await Promise.all([
      fetch(`${origin}/api/auth/ok`),
      fetch(`${origin}/api/audits`),
      fetch(`${origin}${ASSAY_A2A_REST_PATH}/tasks/missing`),
      fetch(`${origin}${ASSAY_A2A_JSON_RPC_PATH}`, {
        method: "POST",
        headers: {
          "A2A-Version": "1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "unauthenticated",
          method: "tasks/get",
          params: { id: "missing-task" },
        }),
      }),
    ]);

    expect(authHealth.status).toBe(200);
    expect(auditHistory.status).toBe(401);
    expect(restA2a.status).not.toBe(401);
    expect(jsonRpcA2a.status).not.toBe(401);
  });
});
