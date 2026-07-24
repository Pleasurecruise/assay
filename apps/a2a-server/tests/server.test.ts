import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { afterEach, describe, expect, test } from "vitest";
import type { Server } from "node:http";
import { ASSAY_A2A_JSON_RPC_PATH, ASSAY_A2A_REST_PATH, createAssayA2AApp } from "../src/server";

const execFileAsync = promisify(execFile);
let server: Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve, reject) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close((error) => {
        server = undefined;
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
});
