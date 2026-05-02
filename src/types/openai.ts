// ─── OpenAI Chat Completions ────────────────────────────────────────────────

export type OpenAIRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export interface OpenAITextContentPart {
  type: "text";
  text: string;
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type OpenAIToolChoiceOption =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

/** Subset of parameters the proxy understands and forwards. */
export interface ChatCompletionsPayload {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stream?: boolean | null;
  stop?: string | string[] | null;
  tools?: OpenAITool[] | null;
  tool_choice?: OpenAIToolChoiceOption | null;
  reasoning_effort?: "low" | "medium" | "high" | null;
  // allow extra fields
  [key: string]: unknown;
}

// ─── OpenAI Chat Completion Response ────────────────────────────────────────

export interface OpenAIChoiceMessage {
  role: "assistant";
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  reasoning?: string | null;
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIChoiceMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs?: null;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

// ─── OpenAI Streaming Chunk ──────────────────────────────────────────────────

export interface OpenAIDelta {
  role?: OpenAIRole;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
  reasoning?: string | null;
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIDelta;
  finish_reason: string | null;
  logprobs?: null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: OpenAIUsage | null;
}

// ─── OpenAI Responses API ────────────────────────────────────────────────────

export interface ResponsesPayload {
  model: string;
  input: ResponseInputItem[];
  instructions?: string | null;
  max_output_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stream?: boolean | null;
  tools?: ResponseTool[] | null;
  tool_choice?: ResponseToolChoice | null;
  reasoning?: { effort?: string } | null;
  // allow extra fields
  [key: string]: unknown;
}

export type ResponseInputItem =
  | { type: "message"; role: "user" | "assistant" | "system"; content: string | ResponseContentBlock[] }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponseContentBlock =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string }
  | { type: "refusal"; refusal: string };

export interface ResponseTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export type ResponseToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string };

// ─── OpenAI Responses API Output ─────────────────────────────────────────────

export interface ResponseOutputText {
  type: "output_text";
  text: string;
}

export interface ResponseOutputRefusal {
  type: "refusal";
  refusal: string;
}

export type ResponseOutputContentPart = ResponseOutputText | ResponseOutputRefusal;

export interface ResponseOutputMessageItem {
  id: string;
  object: "output_item";
  type: "message";
  role: "assistant";
  content: ResponseOutputContentPart[];
  status: "in_progress" | "completed" | "incomplete";
}

export interface ResponseOutputFunctionCallItem {
  id: string;
  object: "output_item";
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
}

export interface ResponseOutputReasoningItem {
  id: string;
  object: "output_item";
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
  status: "in_progress" | "completed" | "incomplete";
}

export type ResponseOutputItem =
  | ResponseOutputMessageItem
  | ResponseOutputFunctionCallItem
  | ResponseOutputReasoningItem;

export interface ResponsesResult {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "failed" | "incomplete" | "in_progress";
  output: ResponseOutputItem[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
  error?: { code: string; message: string } | null;
}
