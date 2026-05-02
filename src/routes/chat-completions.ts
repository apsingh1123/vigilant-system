import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { generateText, jsonSchema, streamText, tool } from "ai";

import {
  getConfig,
  getModel as getModelConfig,
  getThinkingBudget,
} from "../config.js";
import { getModel } from "../provider.js";
import { openaiMessagesToModelMessages } from "../converters/to-model-messages.js";
import {
  makeOpenAIStreamState,
  streamPartToOpenAIChunks,
} from "../converters/stream-to-openai.js";
import type { ChatCompletionsPayload, OpenAITool } from "../types/openai.js";

export const chatCompletionsRoutes = new Hono();

/**
 * POST /v1/chat/completions  (OpenAI Chat Completions API)
 *
 * Converts the OpenAI message format to AI SDK ModelMessages, calls the
 * configured Anthropic backend, and converts the response back to the
 * OpenAI chat completion format (streaming or non-streaming).
 */
chatCompletionsRoutes.post("/", async (c) => {
  const config = getConfig();

  // ── Parse body leniently — unknown fields are silently dropped ──────────
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

  // Cast to typed payload, dropping unknown keys
  const typed = payload as ChatCompletionsPayload;
  const { system, messages } = openaiMessagesToModelMessages(typed);

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
    typed.max_tokens ??
    typed.max_completion_tokens ??
    config.defaultMaxTokens;

  const isStreaming = typed.stream === true;
  const model = getModel(modelId);

  const sharedOptions = {
    model,
    system,
    messages,
    maxTokens,
    temperature: typed.temperature ?? undefined,
    topP: typed.top_p ?? undefined,
    stopSequences: typed.stop
      ? Array.isArray(typed.stop)
        ? typed.stop
        : [typed.stop]
      : undefined,
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
      console.error("[chat-completions] generateText error:", err);
      return c.json(
        { error: { type: "api_error", message: String(err) } },
        500,
      );
    }

    const toolCalls = result.toolCalls.map((tc, i) => ({
      id: tc.toolCallId,
      index: i,
      type: "function" as const,
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.input),
      },
    }));

    return c.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.text || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: mapFinishReason(result.finishReason),
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: result.usage.inputTokens,
        completion_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      },
    });
  }

  // ── Streaming ─────────────────────────────────────────────────────────
  const messageId = `chatcmpl-${Date.now()}`;
  const state = makeOpenAIStreamState(messageId, modelId);

  return streamSSE(c, async (stream) => {
    let sdkStream;
    try {
      sdkStream = streamText(sharedOptions);
    } catch (err) {
      console.error("[chat-completions] streamText error:", err);
      await stream.writeSSE({
        data: JSON.stringify({
          error: { type: "api_error", message: String(err) },
        }),
      });
      return;
    }

    for await (const part of sdkStream.fullStream) {
      const chunks = streamPartToOpenAIChunks(part, state);
      for (const chunk of chunks) {
        await stream.writeSSE({ data: JSON.stringify(chunk) });
      }
      if (part.type === "finish") break;
    }

    await stream.writeSSE({ data: "[DONE]" });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTools(
  tools: OpenAITool[],
): Record<string, ReturnType<typeof tool>> {
  return Object.fromEntries(
    tools.map((t) => [
      t.function.name,
      tool({
        description: t.function.description,
        parameters: jsonSchema(
          (t.function.parameters as object) ?? {
            type: "object",
            properties: {},
          },
        ),
        // No execute — the caller handles tool execution
      }),
    ]),
  );
}

function mapToolChoice(
  tc: ChatCompletionsPayload["tool_choice"],
): import("ai").ToolChoice<Record<string, ReturnType<typeof tool>>> | undefined {
  if (!tc) return undefined;
  if (tc === "none") return "none";
  if (tc === "auto") return "auto";
  if (tc === "required") return "required";
  if (typeof tc === "object" && tc.type === "function") {
    return { type: "tool", toolName: tc.function.name };
  }
  return undefined;
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    default:
      return "stop";
  }
}
