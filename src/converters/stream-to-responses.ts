/**
 * Converts AI SDK TextStreamPart events into OpenAI Responses API SSE events.
 * Reference: https://platform.openai.com/docs/api-reference/responses
 */

import type { TextStreamPart, ToolSet } from "ai";
import type {
  ResponseOutputFunctionCallItem,
  ResponseOutputMessageItem,
  ResponsesResult,
} from "../types/openai.js";

// ─── State ───────────────────────────────────────────────────────────────────

export interface ResponsesStreamState {
  responseId: string;
  model: string;
  created: number;
  /** id of the assistant message output item */
  messageItemId: string;
  messageOutputIndex: number;
  /** cumulative text in the current text part */
  accText: string;
  contentIndex: number;
  messageItemAdded: boolean;
  textPartAdded: boolean;
  /** Maps AI SDK tool-call id → output item info */
  toolCalls: Map<
    string,
    { outputIndex: number; callId: string; name: string; accArgs: string }
  >;
  nextOutputIndex: number;
  finished: boolean;
}

export function makeResponsesStreamState(
  responseId: string,
  model: string,
): ResponsesStreamState {
  return {
    responseId,
    model,
    created: Math.floor(Date.now() / 1000),
    messageItemId: `msg_${responseId}`,
    messageOutputIndex: 0,
    accText: "",
    contentIndex: 0,
    messageItemAdded: false,
    textPartAdded: false,
    toolCalls: new Map(),
    nextOutputIndex: 0,
    finished: false,
  };
}

// ─── Converter ───────────────────────────────────────────────────────────────

export type ResponsesSSEEvent = { event: string; data: string };

export function streamPartToResponsesEvents(
  part: TextStreamPart<ToolSet>,
  state: ResponsesStreamState,
): ResponsesSSEEvent[] {
  const events: ResponsesSSEEvent[] = [];

  const emit = (event: string, data: unknown) => {
    events.push({ event, data: JSON.stringify(data) });
  };

  const baseResponse = () => ({
    id: state.responseId,
    object: "response" as const,
    created_at: state.created,
    model: state.model,
    status: "in_progress" as const,
    output: [] as unknown[],
    usage: null,
  });

  switch (part.type) {
    case "text-start": {
      // Lazily add the message output item on the first text block
      if (!state.messageItemAdded) {
        state.messageOutputIndex = state.nextOutputIndex++;
        state.messageItemAdded = true;
        emit("response.output_item.added", {
          type: "response.output_item.added",
          output_index: state.messageOutputIndex,
          item: {
            id: state.messageItemId,
            object: "output_item",
            type: "message",
            role: "assistant",
            content: [],
            status: "in_progress",
          } satisfies Partial<ResponseOutputMessageItem>,
        });
      }
      if (!state.textPartAdded) {
        state.textPartAdded = true;
        emit("response.content_part.added", {
          type: "response.content_part.added",
          item_id: state.messageItemId,
          output_index: state.messageOutputIndex,
          content_index: state.contentIndex,
          part: { type: "output_text", text: "" },
        });
      }
      break;
    }

    case "text-delta": {
      state.accText += part.text;
      emit("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: state.messageItemId,
        output_index: state.messageOutputIndex,
        content_index: state.contentIndex,
        delta: part.text,
      });
      break;
    }

    case "text-end": {
      emit("response.output_text.done", {
        type: "response.output_text.done",
        item_id: state.messageItemId,
        output_index: state.messageOutputIndex,
        content_index: state.contentIndex,
        text: state.accText,
      });
      emit("response.content_part.done", {
        type: "response.content_part.done",
        item_id: state.messageItemId,
        output_index: state.messageOutputIndex,
        content_index: state.contentIndex,
        part: { type: "output_text", text: state.accText },
      });
      break;
    }

    case "tool-input-start": {
      const outputIndex = state.nextOutputIndex++;
      const callId = `call_${part.id}`;
      state.toolCalls.set(part.id, {
        outputIndex,
        callId,
        name: part.toolName,
        accArgs: "",
      });
      emit("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          id: part.id,
          object: "output_item",
          type: "function_call",
          call_id: callId,
          name: part.toolName,
          arguments: "",
          status: "in_progress",
        } satisfies Partial<ResponseOutputFunctionCallItem>,
      });
      break;
    }

    case "tool-input-delta": {
      const tc = state.toolCalls.get(part.id);
      if (tc) {
        tc.accArgs += part.delta;
        emit("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: part.id,
          output_index: tc.outputIndex,
          delta: part.delta,
        });
      }
      break;
    }

    case "tool-input-end": {
      const tc = state.toolCalls.get(part.id);
      if (tc) {
        emit("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: part.id,
          output_index: tc.outputIndex,
          arguments: tc.accArgs,
        });
        emit("response.output_item.done", {
          type: "response.output_item.done",
          output_index: tc.outputIndex,
          item: {
            id: part.id,
            object: "output_item",
            type: "function_call",
            call_id: tc.callId,
            name: tc.name,
            arguments: tc.accArgs,
            status: "completed",
          },
        });
      }
      break;
    }

    case "finish": {
      state.finished = true;
      const usage = {
        input_tokens: part.totalUsage.inputTokens,
        output_tokens: part.totalUsage.outputTokens,
        total_tokens: part.totalUsage.totalTokens,
      };

      // Close message output item if there was text content
      if (state.messageItemAdded) {
        emit("response.output_item.done", {
          type: "response.output_item.done",
          output_index: state.messageOutputIndex,
          item: {
            id: state.messageItemId,
            object: "output_item",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: state.accText }],
            status: "completed",
          },
        });
      }

      const finalResponse: ResponsesResult = {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        model: state.model,
        status: "completed",
        output: buildOutputItems(state),
        usage,
      };
      emit("response.completed", {
        type: "response.completed",
        response: finalResponse,
      });
      break;
    }

    default:
      break;
  }

  return events;
}

// ─── Non-streaming helpers ───────────────────────────────────────────────────

function buildOutputItems(state: ResponsesStreamState): ResponsesResult["output"] {
  const items: ResponsesResult["output"] = [];

  if (state.messageItemAdded) {
    items.push({
      id: state.messageItemId,
      object: "output_item",
      type: "message",
      role: "assistant",
      content: state.accText ? [{ type: "output_text", text: state.accText }] : [],
      status: "completed",
    });
  }

  for (const [id, tc] of state.toolCalls) {
    items.push({
      id,
      object: "output_item",
      type: "function_call",
      call_id: tc.callId,
      name: tc.name,
      arguments: tc.accArgs,
      status: "completed",
    });
  }

  return items;
}
