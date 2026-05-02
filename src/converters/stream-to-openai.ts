/**
 * Converts AI SDK TextStreamPart events (from streamText.fullStream) into
 * OpenAI chat completion chunk objects for SSE output.
 */

import type { TextStreamPart, ToolSet } from "ai";
import type { ChatCompletionChunk } from "../types/openai.js";

export interface OpenAIStreamState {
  messageId: string;
  model: string;
  created: number;
  /** Maps AI SDK tool-call id → {index in tool_calls array, name} */
  toolCallIndexes: Map<string, { index: number; name: string }>;
  roleSent: boolean;
}

export function makeOpenAIStreamState(
  messageId: string,
  model: string,
): OpenAIStreamState {
  return {
    messageId,
    model,
    created: Math.floor(Date.now() / 1000),
    toolCallIndexes: new Map(),
    roleSent: false,
  };
}

/** Returns zero or more OpenAI chunk objects for each stream part. */
export function streamPartToOpenAIChunks(
  part: TextStreamPart<ToolSet>,
  state: OpenAIStreamState,
): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [];

  const base = (): Omit<ChatCompletionChunk, "choices"> => ({
    id: state.messageId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    usage: null,
  });

  // Send the role on the very first content event
  if (!state.roleSent && isContentEvent(part)) {
    chunks.push({
      ...base(),
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    });
    state.roleSent = true;
  }

  switch (part.type) {
    case "text-delta": {
      chunks.push({
        ...base(),
        choices: [
          {
            index: 0,
            delta: { content: part.text },
            finish_reason: null,
          },
        ],
      });
      break;
    }

    case "tool-input-start": {
      const idx = state.toolCallIndexes.size;
      state.toolCallIndexes.set(part.id, { index: idx, name: part.toolName });
      chunks.push({
        ...base(),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: idx,
                  id: part.id,
                  type: "function",
                  function: { name: part.toolName, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      break;
    }

    case "tool-input-delta": {
      const tc = state.toolCallIndexes.get(part.id);
      if (tc) {
        chunks.push({
          ...base(),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: tc.index, function: { arguments: part.delta } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      }
      break;
    }

    case "finish": {
      chunks.push({
        ...base(),
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: mapFinishReason(part.finishReason),
          },
        ],
        usage: {
          prompt_tokens: part.totalUsage.inputTokens,
          completion_tokens: part.totalUsage.outputTokens,
          total_tokens: part.totalUsage.totalTokens,
        },
      });
      break;
    }

    default:
      break;
  }

  return chunks;
}

function isContentEvent(part: TextStreamPart<ToolSet>): boolean {
  return (
    part.type === "text-delta" ||
    part.type === "tool-input-start" ||
    part.type === "reasoning-delta"
  );
}

function mapFinishReason(
  reason: string,
): ChatCompletionChunk["choices"][0]["finish_reason"] {
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
