/**
 * Converts OpenAI Chat Completions or Responses API input into the AI SDK
 * ModelMessage format used by generateText / streamText.
 *
 * Unknown fields on incoming payloads are silently dropped so that clients
 * passing non-standard parameters never cause upstream failures.
 */

import type {
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import type {
  ChatCompletionsPayload,
  OpenAIMessage,
  ResponseInputItem,
  ResponsesPayload,
} from "../types/openai.js";

// ─── OpenAI Chat Completions → ModelMessages ────────────────────────────────

export function openaiMessagesToModelMessages(
  payload: ChatCompletionsPayload,
): { system: string | undefined; messages: ModelMessage[] } {
  const systemParts: string[] = [];
  const messages: ModelMessage[] = [];

  for (const msg of payload.messages) {
    if (msg.role === "system") {
      systemParts.push(typeof msg.content === "string" ? msg.content : "");
      continue;
    }
    const converted = convertOpenAIMessage(msg);
    if (converted) messages.push(converted);
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}

function convertOpenAIMessage(msg: OpenAIMessage): ModelMessage | null {
  switch (msg.role) {
    case "assistant":
      return convertOpenAIAssistantMessage(msg);
    case "user":
      return convertOpenAIUserMessage(msg);
    case "tool":
      return convertOpenAIToolMessage(msg);
    default:
      return null;
  }
}

function convertOpenAIAssistantMessage(
  msg: OpenAIMessage,
): AssistantModelMessage {
  type AssistantPart = AssistantModelMessage["content"] extends
    | string
    | (infer P)[]
    ? P
    : never;
  const parts: AssistantPart[] = [];

  const text =
    typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("")
        : null;
  if (text) parts.push({ type: "text", text } as AssistantPart);

  for (const tc of msg.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      // keep empty object on parse failure
    }
    parts.push({
      type: "tool-call",
      toolCallId: tc.id,
      toolName: tc.function.name,
      input,
    } as AssistantPart);
  }

  return { role: "assistant", content: parts.length === 0 ? "" : parts };
}

function convertOpenAIUserMessage(msg: OpenAIMessage): UserModelMessage {
  if (!msg.content) return { role: "user", content: "" };

  if (typeof msg.content === "string") {
    return { role: "user", content: msg.content };
  }

  type UserPart = UserModelMessage["content"] extends string | (infer P)[]
    ? P
    : never;

  const parts: UserPart[] = msg.content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text } as UserPart;
    }
    // image_url
    const url = (part as { type: "image_url"; image_url: { url: string } })
      .image_url.url;
    if (url.startsWith("data:")) {
      const [meta, data] = url.split(",");
      const mediaType = meta.split(":")[1]?.split(";")[0] ?? "image/jpeg";
      return {
        type: "image",
        image: data ?? "",
        mediaType,
      } as UserPart;
    }
    return { type: "image", image: new URL(url) } as UserPart;
  });

  return { role: "user", content: parts };
}

function convertOpenAIToolMessage(msg: OpenAIMessage): ToolModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: msg.tool_call_id ?? "",
        toolName: msg.name ?? "",
        output: {
          type: "text",
          value:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
        },
      },
    ],
  };
}

// ─── OpenAI Responses API → ModelMessages ───────────────────────────────────

export function responsesInputToModelMessages(
  payload: ResponsesPayload,
): { system: string | undefined; messages: ModelMessage[] } {
  const messages: ModelMessage[] = [];

  for (const item of payload.input) {
    const converted = convertResponsesInputItem(item);
    if (converted) messages.push(converted);
  }

  return {
    system: payload.instructions ?? undefined,
    messages,
  };
}

function convertResponsesInputItem(
  item: ResponseInputItem,
): ModelMessage | null {
  if (item.type === "message") {
    if (item.role === "user" || item.role === "system") {
      if (typeof item.content === "string") {
        return { role: "user", content: item.content };
      }
      type UserPart = UserModelMessage["content"] extends string | (infer P)[]
        ? P
        : never;
      const parts: UserPart[] = item.content
        .filter((b) => b.type === "input_text" || b.type === "input_image")
        .map((b) => {
          if (b.type === "input_image") {
            const url = (
              b as { type: "input_image"; image_url: string }
            ).image_url;
            if (url.startsWith("data:")) {
              const [meta, data] = url.split(",");
              const mediaType =
                meta.split(":")[1]?.split(";")[0] ?? "image/jpeg";
              return {
                type: "image",
                image: data ?? "",
                mediaType,
              } as UserPart;
            }
            return { type: "image", image: new URL(url) } as UserPart;
          }
          return {
            type: "text",
            text: (b as { type: "input_text"; text: string }).text,
          } as UserPart;
        });
      return { role: "user", content: parts };
    }

    if (item.role === "assistant") {
      if (typeof item.content === "string") {
        return { role: "assistant", content: item.content };
      }
      const text = item.content
        .filter((b) => b.type === "output_text")
        .map((b) => (b as { type: "output_text"; text: string }).text)
        .join("");
      return { role: "assistant", content: text };
    }

    return null;
  }

  if (item.type === "function_call") {
    let input: unknown = {};
    try {
      input = JSON.parse(item.arguments);
    } catch {
      // keep empty input
    }
    return {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: item.id,
          toolName: item.name,
          input,
        },
      ],
    };
  }

  if (item.type === "function_call_output") {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: item.call_id,
          toolName: "",
          output: { type: "text", value: item.output },
        },
      ],
    };
  }

  return null;
}
