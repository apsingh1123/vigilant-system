import { Hono } from "hono";
import { getConfig } from "../config.js";

export const modelsRoutes = new Hono();

/**
 * GET /v1/models
 *
 * Returns the model list defined in config.json in an OpenAI-compatible format.
 * Anthropic clients also use this endpoint for model discovery.
 */
modelsRoutes.get("/", (c) => {
  const { models } = getConfig();

  const data = models.map((m) => ({
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "anthropic",
    display_name: m.name,
    context_window: m.maxInputTokens,
  }));

  return c.json({ object: "list", data });
});
