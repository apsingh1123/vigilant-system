import { Hono } from "hono";
import { streamText as honoStreamText } from "hono/streaming";

import { getConfig, getModel as getModelConfig } from "../config.js";

export const messagesRoutes = new Hono();

/**
 * POST /v1/messages  (Anthropic Messages API)
 *
 * Direct HTTP proxy to the configured Anthropic-compatible backend.
 * Proxying directly preserves the full Anthropic wire format — including
 * thinking-block cryptographic signatures that are required for multi-turn
 * extended-thinking conversations.
 *
 * The only modification made to the request is optionally injecting the
 * `thinking` parameter from config.json when the model supports it and the
 * client hasn't already specified one.
 */
messagesRoutes.post("/", async (c) => {
  const config = getConfig();

  // ── Parse body leniently ────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json(
      { error: { type: "invalid_request_error", message: "Invalid JSON body." } },
      400,
    );
  }

  const modelId =
    typeof body.model === "string" ? body.model : undefined;
  if (!modelId) {
    return c.json(
      { error: { type: "invalid_request_error", message: "Missing required field: model." } },
      400,
    );
  }
  if (!body.messages) {
    return c.json(
      { error: { type: "invalid_request_error", message: "Missing required field: messages." } },
      400,
    );
  }
  if (body.max_tokens === undefined) {
    body = { ...body, max_tokens: config.defaultMaxTokens };
  }

  // ── Inject thinking config if eligible ─────────────────────────────────
  const modelCfg = getModelConfig(modelId);
  if (
    modelCfg?.supportsThinking &&
    config.thinking.enabled &&
    body.thinking === undefined
  ) {
    body = {
      ...body,
      thinking: {
        type: "enabled",
        budget_tokens: config.thinking.budgetTokens,
      },
    };
  }

  // ── Forward to backend ──────────────────────────────────────────────────
  const backendUrl = `${config.backend.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const apiKey =
    config.backend.apiKey || process.env.ANTHROPIC_API_KEY || "";

  let upstream: Response;
  try {
    upstream = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": config.backend.anthropicVersion,
        // Forward any anthropic-beta header from the client
        ...(c.req.header("anthropic-beta")
          ? { "anthropic-beta": c.req.header("anthropic-beta")! }
          : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[messages] Backend fetch error:", err);
    return c.json(
      { error: { type: "api_error", message: "Failed to reach the backend." } },
      502,
    );
  }

  if (!upstream.ok) {
    const errorText = await upstream.text();
    return new Response(errorText, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  const isStreaming = body.stream === true;

  if (!isStreaming || !upstream.body) {
    const data = await upstream.json();
    return c.json(data);
  }

  // ── Stream back the raw Anthropic SSE ──────────────────────────────────
  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-cache");
  c.header("connection", "keep-alive");

  return honoStreamText(c, async (stream) => {
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await stream.write(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  });
});
