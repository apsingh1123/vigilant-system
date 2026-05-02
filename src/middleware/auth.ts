import type { MiddlewareHandler } from "hono";
import { getConfig } from "../config.js";

/**
 * Simple bearer-token / x-api-key auth middleware.
 * Skipped entirely when config.apiKeys is empty (open access).
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const { apiKeys } = getConfig();

  if (apiKeys.length === 0) {
    return next();
  }

  const authHeader = c.req.header("authorization");
  const xApiKey = c.req.header("x-api-key");

  const provided =
    (authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null) ?? xApiKey?.trim();

  if (!provided || !apiKeys.includes(provided)) {
    return c.json(
      {
        error: {
          type: "authentication_error",
          message: "Invalid or missing API key.",
        },
      },
      401,
    );
  }

  return next();
};
