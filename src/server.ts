import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { authMiddleware } from "./middleware/auth.js";
import { chatCompletionsRoutes } from "./routes/chat-completions.js";
import { messagesRoutes } from "./routes/messages.js";
import { modelsRoutes } from "./routes/models.js";
import { responsesRoutes } from "./routes/responses.js";

export function createServer(): Hono {
  const app = new Hono();

  app.use("*", logger());
  app.use("*", cors());
  app.use("*", authMiddleware);

  app.get("/", (c) => c.text("vigilant-system proxy running ✓"));
  app.get("/health", (c) => c.json({ status: "ok" }));

  // ── OpenAI-compatible endpoints ────────────────────────────────────────
  app.route("/v1/models", modelsRoutes);
  app.route("/v1/chat/completions", chatCompletionsRoutes);
  app.route("/v1/responses", responsesRoutes);

  // ── Anthropic-compatible endpoint ──────────────────────────────────────
  app.route("/v1/messages", messagesRoutes);

  // ── Bare (no v1 prefix) aliases ────────────────────────────────────────
  app.route("/models", modelsRoutes);
  app.route("/chat/completions", chatCompletionsRoutes);
  app.route("/responses", responsesRoutes);
  app.route("/messages", messagesRoutes);

  return app;
}
