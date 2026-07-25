import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { afterEach, describe, expect, test } from "vitest";
import type { Server } from "node:http";
import { createAssayAuth } from "../src/auth";
import { AssayDatabase } from "../src/database";
import { ASSAY_A2A_JSON_RPC_PATH, ASSAY_A2A_REST_PATH, createAssayA2AApp } from "../src/server";

const execFileAsync = promisify(execFile);
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
  test("serves a JSON-RPC curl handshake alongside the REST transport", async () => {
    const executor: AgentExecutor = {
      execute: async () => {
        throw new Error("handshake must not execute an audit");
      },
      cancelTask: async () => {
        throw new Error("handshake must not cancel an audit");
      },
    };
    const service = createAssayA2AApp({ executor });
    server = service.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }

    const { stdout } = await execFileAsync("curl", [
      "--silent",
      "--show-error",
      "--request",
      "POST",
      "--header",
      "Content-Type: application/json",
      "--data",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "assay-handshake",
        method: "tasks/get",
        params: { id: "missing-task" },
      }),
      `http://127.0.0.1:${String(address.port)}${ASSAY_A2A_JSON_RPC_PATH}`,
    ]);
    const response = JSON.parse(stdout) as Record<string, unknown>;

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("assay-handshake");
    expect(service.agentCard.supportedInterfaces?.map((item) => item.url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(ASSAY_A2A_REST_PATH),
        expect.stringContaining(ASSAY_A2A_JSON_RPC_PATH),
      ]),
    );
  });

  test("mounts Better Auth and rejects unauthenticated private routes", async () => {
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

    const [authHealth, auditHistory, a2a] = await Promise.all([
      fetch(`${origin}/api/auth/ok`),
      fetch(`${origin}/api/audits`),
      fetch(`${origin}${ASSAY_A2A_REST_PATH}/tasks/missing`),
    ]);

    expect(authHealth.status).toBe(200);
    expect(auditHistory.status).toBe(401);
    expect(a2a.status).toBe(401);
  });
});
