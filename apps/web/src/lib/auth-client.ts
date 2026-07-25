import { createAuthClient } from "better-auth/react";

export const authClient: ReturnType<typeof createAuthClient> = createAuthClient({
  baseURL: globalThis.location.origin,
  fetchOptions: {
    credentials: "include",
  },
});
