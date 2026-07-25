import { defaultServerCallContextBuilder, type TaskStore, type User } from "@a2a-js/sdk/server";
import type { Request, RequestHandler } from "express";

type UserBuilder = (request: Request) => Promise<User>;

export function createMissingTaskNormalizer(
  taskStore: TaskStore,
  userBuilder: UserBuilder,
): RequestHandler {
  return async (request, response, next) => {
    const requestedVersion = request.get("A2A-Version");
    if (!requestedVersion?.startsWith("1.")) {
      next();
      return;
    }

    try {
      const taskId = request.params.taskId;
      if (typeof taskId !== "string" || taskId.length === 0) {
        next();
        return;
      }
      const user = await userBuilder(request);
      const context = defaultServerCallContextBuilder({
        extensions: undefined,
        user,
        headers: request.headers,
        requestedVersion,
      });
      if ((await taskStore.load(taskId, context)) !== undefined) {
        next();
        return;
      }
      response
        .status(404)
        .type("application/a2a+json")
        .json({
          error: {
            code: 404,
            status: "NOT_FOUND",
            message: `Task not found: ${taskId}`,
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "TASK_NOT_FOUND",
                domain: "a2a-protocol.org",
              },
            ],
          },
        });
    } catch (error) {
      next(error);
    }
  };
}
