import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface ModelConfig {
  id: string;
  name: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
}

export interface BackendConfig {
  baseUrl: string;
  apiKey: string;
  anthropicVersion: string;
}

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
}

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";

export interface ReasoningEffortConfig {
  default: ReasoningEffort;
  perModel: Record<string, ReasoningEffort>;
}

export interface AppConfig {
  port: number;
  /** API keys clients must supply. Empty array = no authentication required. */
  apiKeys: string[];
  backend: BackendConfig;
  models: ModelConfig[];
  thinking: ThinkingConfig;
  reasoningEffort: ReasoningEffortConfig;
  defaultMaxTokens: number;
  /**
   * When false (default) the proxy silently drops unknown request fields
   * instead of forwarding them to the backend, preventing upstream 400s.
   */
  strictMode: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  port: 3000,
  apiKeys: [],
  backend: {
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    anthropicVersion: "2023-06-01",
  },
  models: [],
  thinking: {
    enabled: true,
    budgetTokens: 10000,
  },
  reasoningEffort: {
    default: "medium",
    perModel: {},
  },
  defaultMaxTokens: 4096,
  strictMode: false,
};

let cachedConfig: AppConfig | null = null;

function loadConfig(): AppConfig {
  // CONFIG_PATH env var takes precedence over the default location
  const configPath =
    process.env.CONFIG_PATH ?? resolve(process.cwd(), "config.json");

  if (!existsSync(configPath)) {
    console.warn(
      `[config] ${configPath} not found – using built-in defaults. ` +
        `Set CONFIG_PATH or place a config.json in the working directory.`
    );
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch (err) {
    console.error("[config] Failed to parse config file, using defaults:", err);
    return { ...DEFAULT_CONFIG };
  }
}

/** Shallow-merge top-level keys; for nested objects do a one-level deep merge. */
function deepMerge(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  const result = { ...base } as AppConfig;
  for (const key of Object.keys(override) as (keyof AppConfig)[]) {
    const val = override[key];
    if (val === undefined || val === null) continue;
    if (
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = { ...(base[key] as object), ...(val as object) };
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = val;
    }
  }
  return result;
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function getModel(modelId: string): ModelConfig | undefined {
  return getConfig().models.find((m) => m.id === modelId);
}

export function getReasoningEffort(modelId: string): ReasoningEffort {
  const cfg = getConfig();
  return cfg.reasoningEffort.perModel[modelId] ?? cfg.reasoningEffort.default;
}

export function getThinkingBudget(modelId: string): number {
  const cfg = getConfig();
  const model = getModel(modelId);
  if (!model?.supportsThinking || !cfg.thinking.enabled) return 0;
  return cfg.thinking.budgetTokens;
}
