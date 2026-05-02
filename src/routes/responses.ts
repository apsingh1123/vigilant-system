import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { generateText, jsonSchema, streamText, tool } from "ai";

import {
  getConfig,
  getModel as getModelConfig,
  getThinkingBudget,
} from "../config.js";
import { getModel } from "../provider.js";
import { responsesInputToModelMessages } from "../converters/to-model-messages.js";
import {
  makeResponsesStreamState,
  streamPartToResponsesEvents,
} from "../converters/stream-to-responses.js";
import type {
  ResponsesPayload,
  ResponseTool,
  ResponsesResult,
} from "../types/openai.js";

export const responsesRoutes = new Hono();

/**
 * POST /v1/responses  (OpenAI Responses API)
 *
 * Converts the Responses API `input` array and `instructions` into AI SDK
 * ModelMessages, calls the configured backend, and returns the response in
 * Responses API format (streaming or non-streaming).
 */
responsesRoutes.post("/", async (c) => {
  const config = getConfig();

  // ── Parse body leniently ────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json(
      { error: { type: "invalid_request_error", message: "Invalid JSON body." } },
      400,
    );
  }

  const modelId = typeof payload.model === "string" ? payload.model : undefined;
  if (!modelId) {
    return c.json(
      { error: { type: "invalid_request_error", message: "Missing required field: model." } },
      400,
    );
  }
  if (!Array.isArray(payload.input)) {
    return c.json(
      { error: { type: "invalid_request_error", message: "Missing required field: input (array)." } },
      400,
    );
  }

  const typed = payload as ResponsesPayload;
  const { system, messages } = responsesInputToModelMessages(typed);

  // ── Tool definitions ────────────────────────────────────────────────────
  const aiTools = buildTools(typed.tools ?? []);
  const toolChoice = mapToolChoice(typed.tool_choice);

  // ── Thinking / reasoning ────────────────────────────────────────────────
  const modelCfg = getModelConfig(modelId);
  const thinkingBudget = getThinkingBudget(modelId);
  const supportsThinking = modelCfg?.supportsThinking ?? false;
  const providerOptions =
    supportsThinking && thinkingBudget > 0
      ? { anthropic: { thinking: { type: "enabled", budgetTokens: thinkingBudget } } }
      : {};

  const maxTokens =
    typed.max_output_tokens ?? config.defaultMaxTokens;

  const isStreaming = typed.stream === true;
  const model = getModel(modelId);
  const responseId = `resp_${Date.now()}`;

  const sharedOptions = {
    model,
    system,
    messages,
    maxTokens,
    temperature: typed.temperature ?? undefined,
    topP: typed.top_p ?? undefined,
    tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
    toolChoice: toolChoice ?? undefined,
    maxSteps: 1,
    providerOptions,
  } as const;

  if (!isStreaming) {
    // ── Non-streaming ─────────────────────────────────────────────────────
    let result;
    try {
      result = await generateText(sharedOptions);
    } catch (err) {
      console.error("[responses] generateText error:", err);
      return c.json(
        { error: { type: "api_error", message: String(err) } },
        500,
      );
    }

    const output: ResponsesResult["output"] = [];
    const created = Math.floor(Date.now() / 1000);

    if (result.text) {
      output.push({
        id: `msg_${responseId}`,
        object: "output_item",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: result.text }],
        status: "completed",
      });
    }

    for (const tc of result.toolCalls) {
      output.push({
        id: tc.toolCallId,
        object: "output_item",
        type: "function_call",
        call_id: `call_${tc.toolCallId}`,
        name: tc.toolName,
        arguments: JSON.stringify(tc.input),
        status: "completed",
      });
    }

    const response: ResponsesResult = {
      id: responseId,
      object: "response",
      created_at: created,
      model: modelId,
      status: "completed",
      output,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      },
    };

    return c.json(response);
  }

  // ── Streaming ─────────────────────────────────────────────────────────
  const state = makeResponsesStreamState(responseId, modelId);
  const created = state.created;

  return streamSSE(c, async (stream) => {
    // Emit response.created and response.in_progress up front
    const baseResponse = {
      id: responseId,
      object: "response" as const,
      created_at: created,
      model: modelId,
      status: "in_progress" as const,
      output: [],
      usage: null,
    };
    await stream.writeSSE({
      event: "response.created",
      data: JSON.stringify({ type: "response.created", response: baseResponse }),
    });
    await stream.writeSSE({
      event: "response.in_progress",
      data: JSON.stringify({ type: "response.in_progress", response: baseResponse }),
    });

    let sdkStream;
    try {
      sdkStream = streamText(sharedOptions);
    } catch (err) {
      console.error("[responses] streamText error:", err);
      await stream.writeSSE({
        event: "response.failed",
        data: JSON.stringify({
          type: "response.failed",
          response: {
            ...baseResponse,
            status: "failed",
            error: { code: "api_error", message: String(err) },
          },
        }),
      });
      return;
    }

    for await (const part of sdkStream.fullStream) {
      const events = streamPartToResponsesEvents(part, state);
      for (const ev of events) {
        await stream.writeSSE({ event: ev.event, data: ev.data });
      }
      if (part.type === "finish") break;
    }
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTools(
  tools: ResponseTool[],
): Record<string, ReturnType<typeof tool>> {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        parameters: jsonSchema(
          (t.parameters as object) ?? { type: "object", properties: {} },
        ),
      }),
    ]),
  );
}

function mapToolChoice(
  tc: ResponsesPayload["tool_choice"],
): import("ai").ToolChoice<Record<string, ReturnType<typeof tool>>> | undefined {
  if (!tc) return undefined;
  if (tc === "none") return "none";
  if (tc === "auto") return "auto";
  if (tc === "required") return "required";
  if (typeof tc === "object" && tc.type === "function") {
    return { type: "tool", toolName: tc.name };
  }
  return undefined;
}
