import { PROMPT_VERSION, RUBRIC_VERSION, type JudgeConfig } from "./judge.ts";

/** A pilot configuration, not a claim of human calibration or provider immutability. */
export const LIVE_JUDGE_CONFIG: JudgeConfig = Object.freeze({
  version: "antislop.judge-config.v1",
  seasonId: "antislop-pilot-2026-09-v1",
  provider: "vercel-gateway.alibaba.json-schema-v1",
  modelSnapshot: "alibaba/qwen3-next-80b-a3b-instruct",
  rubricVersion: RUBRIC_VERSION,
  promptVersion: PROMPT_VERSION,
  temperature: 0,
  maxOutputTokens: 1800,
  phase: "calibration",
});

export const VERDICT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["a_wins", "b_wins", "draw", "unrated"] },
    reason: { type: "string", enum: ["stronger_work", "comparable_work", "insufficient_evidence", "incomparable_entries"] },
    explanation: { type: "string" },
    evidenceRefs: {
      type: "object", additionalProperties: false,
      properties: { a: { type: "array", items: { type: "string" } }, b: { type: "array", items: { type: "string" } } },
      required: ["a", "b"],
    },
  },
  required: ["outcome", "reason", "explanation", "evidenceRefs"],
} as const;
