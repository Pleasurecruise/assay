import { AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { UserBuilder, agentCardHandler, restHandler } from "@a2a-js/sdk/server/express";
import express, { type Express } from "express";
import { createAssayAgentCard } from "./agent-card";
import { DEFAULT_ASSAY_A2A_CORS_ORIGIN } from "./configuration";

export interface CreateAssayA2AAppOptions {
  executor: AgentExecutor;
  publicUrl?: string;
  corsOrigin?: string;
  agentCard?: AgentCard;
  taskStore?: TaskStore;
}

export interface AssayA2AApp {
  app: Express;
  agentCard: AgentCard;
  requestHandler: DefaultRequestHandler;
  taskStore: TaskStore;
}

function normalizePublicUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function createAssayA2AApp(options: CreateAssayA2AAppOptions): AssayA2AApp {
  const publicUrl = normalizePublicUrl(options.publicUrl ?? "http://127.0.0.1:3001");
  const corsOrigin = options.corsOrigin ?? DEFAULT_ASSAY_A2A_CORS_ORIGIN;
  const agentCard = options.agentCard ?? createAssayAgentCard(`${publicUrl}/a2a`);
  const taskStore = options.taskStore ?? new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, options.executor);
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.vary("Origin");
    if (request.get("Origin") === corsOrigin) {
      response.setHeader("Access-Control-Allow-Origin", corsOrigin);
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, A2A-Version");
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(
    "/a2a",
    restHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });

  return {
    app,
    agentCard,
    requestHandler,
    taskStore,
  };
}
