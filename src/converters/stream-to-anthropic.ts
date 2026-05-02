/**
 * Converts AI SDK TextStreamPart events (from streamText.fullStream) into
 * Anthropic SSE events for the /v1/messages endpoint.
 *
 * Note: thinking blocks are emitted without cryptographic signatures because
 * the AI SDK abstracts them away. For multi-turn conversations where Anthropic
 * requires signatures, use the direct-proxy /v1/messages endpoint instead
 * of routing through the AI SDK.
 */

import type { TextStreamPart, ToolSet } from "ai";
import type { AnthropicStreamEvent } from "../types/anthropic.js";

export interface AnthropicStreamState {
  messageId: string;
  model: string;
  messageStartSent: boolean;
  /** Index of the next block to open */
  nextBlockIndex: number;
  /** Currently open text block index (-1 = none) */
  textBlockIndex: number;
  /** Currently open thinking block index (-1 = none) */
  thinkingBlockIndex: number;
  /** Maps AI SDK tool-call id → block index */
  toolBlockIndexes: Map<string, number>;
  inputTokens: number;
}

export function makeAnthropicStreamState(
  messageId: string,
  model: string,
): AnthropicStreamState {
  return {
    messageId,
    model,
    messageStartSent: false,
    nextBlockIndex: 0,
    textBlockIndex: -1,
    thinkingBlockIndex: -1,
    toolBlockIndexes: new Map(),
    inputTokens: 0,
  };
}

/** Returns zero or more Anthropic stream events for each AI SDK stream part. */
export function streamPartToAnthropicEvents(
  part: TextStreamPart<ToolSet>,
  state: AnthropicStreamState,
): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];

  // Emit message_start once, before the first real content block
  if (!state.messageStartSent && isOpeningEvent(part)) {
    events.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: state.inputTokens, output_tokens: 0 },
      },
    });
    state.messageStartSent = true;
  }

  switch (part.type) {
    // ── Thinking / Reasoning ──────────────────────────────────────────────
    case "reasoning-start": {
      const idx = state.nextBlockIndex++;
      state.thinkingBlockIndex = idx;
      events.push({
        type: "content_block_start",
        index: idx,
        content_block: { type: "thinking", thinking: "" },
      });
      break;
    }

    case "reasoning-delta": {
      if (state.thinkingBlockIndex >= 0) {
        events.push({
          type: "content_block_delta",
          index: state.thinkingBlockIndex,
          delta: { type: "thinking_delta", thinking: part.text },
        });
      }
      break;
    }

    case "reasoning-end": {
      if (state.thinkingBlockIndex >= 0) {
        // Emit an empty signature delta so downstream parsers that expect one
        // don't break — the content is still useful even without a real sig.
        events.push(
          {
            type: "content_block_delta",
            index: state.thinkingBlockIndex,
            delta: { type: "signature_delta", signature: "" },
          },
          {
            type: "content_block_stop",
            index: state.thinkingBlockIndex,
          },
        );
        state.thinkingBlockIndex = -1;
      }
      break;
    }

    // ── Text ─────────────────────────────────────────────────────────────
    case "text-start": {
      const idx = state.nextBlockIndex++;
      state.textBlockIndex = idx;
      events.push({
        type: "content_block_start",
        index: idx,
        content_block: { type: "text", text: "" },
      });
      break;
    }

    case "text-delta": {
      if (state.textBlockIndex >= 0) {
        events.push({
          type: "content_block_delta",
          index: state.textBlockIndex,
          delta: { type: "text_delta", text: part.text },
        });
      }
      break;
    }

    case "text-end": {
      if (state.textBlockIndex >= 0) {
        events.push({
          type: "content_block_stop",
          index: state.textBlockIndex,
        });
        state.textBlockIndex = -1;
      }
      break;
    }

    // ── Tool calls ───────────────────────────────────────────────────────
    case "tool-input-start": {
      const idx = state.nextBlockIndex++;
      state.toolBlockIndexes.set(part.id, idx);
      events.push({
        type: "content_block_start",
        index: idx,
        content_block: {
          type: "tool_use",
          id: part.id,
          name: part.toolName,
          input: {},
        },
      });
      break;
    }

    case "tool-input-delta": {
      const idx = state.toolBlockIndexes.get(part.id);
      if (idx !== undefined) {
        events.push({
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: part.delta },
        });
      }
      break;
    }

    case "tool-input-end": {
      const idx = state.toolBlockIndexes.get(part.id);
      if (idx !== undefined) {
        events.push({ type: "content_block_stop", index: idx });
      }
      break;
    }

    // ── Finish ────────────────────────────────────────────────────────────
    case "finish": {
      // Ensure message_start was emitted (e.g. model returned empty response)
      if (!state.messageStartSent) {
        events.push({
          type: "message_start",
          message: {
            id: state.messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: state.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: state.inputTokens, output_tokens: 0 },
          },
        });
        state.messageStartSent = true;
      }
      events.push(
        {
          type: "message_delta",
          delta: {
            stop_reason: mapFinishReason(part.finishReason),
            stop_sequence: null,
          },
          usage: { output_tokens: part.totalUsage.outputTokens },
        },
        { type: "message_stop" },
      );
      break;
    }

    default:
      break;
  }

  return events;
}

function isOpeningEvent(part: TextStreamPart<ToolSet>): boolean {
  return (
    part.type === "text-start" ||
    part.type === "reasoning-start" ||
    part.type === "tool-input-start"
  );
}

function mapFinishReason(
  reason: string,
): "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}
