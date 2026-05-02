// ─── Request / Payload Types ───────────────────────────────────────────────

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data?: string;
    url?: string;
  };
}

export interface AnthropicDocumentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
  title?: string | null;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicToolResultContentBlock[];
  is_error?: boolean;
}

export type AnthropicToolResultContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock;

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolResultBlock;

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export interface AnthropicUserMessage {
  role: "user";
  content: string | AnthropicUserContentBlock[];
}

export interface AnthropicAssistantMessage {
  role: "assistant";
  content: string | AnthropicAssistantContentBlock[];
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage;

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicThinkingParam =
  | { type: "enabled"; budget_tokens: number }
  | { type: "disabled" };

export interface AnthropicMessagesPayload {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens: number;
  stream?: boolean;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none";
    name?: string;
  };
  thinking?: AnthropicThinkingParam;
  metadata?: { user_id?: string };
  // allow any extra fields so unknown client params don't crash JSON serialisation
  [key: string]: unknown;
}

// ─── Response Types ─────────────────────────────────────────────────────────

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicAssistantContentBlock[];
  model: string;
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ─── Streaming Event Types ───────────────────────────────────────────────────

export interface AnthropicMessageStartEvent {
  type: "message_start";
  message: Omit<AnthropicResponse, "content" | "stop_reason" | "stop_sequence"> & {
    content: [];
    stop_reason: null;
    stop_sequence: null;
  };
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & { input: Record<string, unknown> })
    | { type: "thinking"; thinking: string };
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string };
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"];
    stop_sequence?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens: number;
  };
}

export interface AnthropicMessageStopEvent {
  type: "message_stop";
}

export interface AnthropicPingEvent {
  type: "ping";
}

export interface AnthropicErrorEvent {
  type: "error";
  error: { type: string; message: string };
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent;

// Mutable state used while translating a stream of OpenAI chunks → Anthropic events
export interface AnthropicStreamState {
  messageStartSent: boolean;
  contentBlockIndex: number;
  contentBlockOpen: boolean;
  thinkingBlockOpen: boolean;
  toolCalls: Record<
    number,
    { id: string; name: string; anthropicBlockIndex: number }
  >;
}
