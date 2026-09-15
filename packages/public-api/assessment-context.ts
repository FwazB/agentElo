export const AI_SYSTEMS = {
  chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", copilot: "Copilot",
  codex: "Codex", other: "Other", unknown: "Unknown",
} as const;

export const CONTEXT_SOURCES = {
  current_chat: "Current chat", saved_memory: "Saved memory", past_chats: "Past chats",
  activity_records: "Activity records", user_summary: "User summary", mixed: "Mixed", unknown: "Unknown",
} as const;

export type AiSystem = keyof typeof AI_SYSTEMS;
export type ContextSource = keyof typeof CONTEXT_SOURCES;
export interface AssessmentContext { aiSystem: AiSystem; contextSource: ContextSource }

/** Only public categories are accepted; never model names, prompts, or evidence text. */
export function parseAssessmentContext(value: unknown): AssessmentContext {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 2) {
    throw new Error("Invalid assessment context.");
  }
  const ai = Object.getOwnPropertyDescriptor(value, "aiSystem");
  const context = Object.getOwnPropertyDescriptor(value, "contextSource");
  if (!ai || !context || !Object.hasOwn(ai, "value") || !Object.hasOwn(context, "value") ||
      typeof ai.value !== "string" || ai.value.length > 32 || !Object.hasOwn(AI_SYSTEMS, ai.value) ||
      typeof context.value !== "string" || context.value.length > 32 || !Object.hasOwn(CONTEXT_SOURCES, context.value)) {
    throw new Error("Invalid assessment context.");
  }
  return { aiSystem: ai.value as AiSystem, contextSource: context.value as ContextSource };
}
