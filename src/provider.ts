import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

import { getConfig } from "./config.js";

/**
 * Returns a configured AI SDK Anthropic provider that points at the backend
 * URL and API key defined in config.json (or CONFIG_PATH).
 */
export function getModel(modelId: string): LanguageModel {
  const { backend } = getConfig();

  const anthropic = createAnthropic({
    apiKey: backend.apiKey || process.env.ANTHROPIC_API_KEY || "",
    baseURL: backend.baseUrl,
    headers: {
      "anthropic-version": backend.anthropicVersion,
    },
  });

  return anthropic(modelId);
}
