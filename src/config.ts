import { z } from "zod";
import { defaultSandboxImage } from "./docker.js";

export const codexCageConfigSchema = z
  .object({
    setup: z.array(z.string()).default([]),
    verify: z.array(z.string()).min(1),
    services: z
      .object({
        compose: z.string().nullable().default(null),
        ready: z.array(z.string()).default([]),
      })
      .default(() => ({ compose: null, ready: [] })),
    runtime: z
      .object({
        image: z.string().min(1).default(defaultSandboxImage),
        dockerfile: z.string().min(1).nullable().default(null),
      })
      .default(() => ({ image: defaultSandboxImage, dockerfile: null })),
    agent: z
      .object({
        model: z.string().default("gpt-5.4"),
        max_iterations: z.number().int().positive().default(5),
        max_review_cycles: z.number().int().nonnegative().default(2),
      })
      .default(() => ({ model: "gpt-5.4", max_iterations: 5, max_review_cycles: 2 })),
    timeouts: z
      .object({
        total_minutes: z.number().int().positive().default(90),
        command_minutes: z.number().int().positive().default(20),
        idle_minutes: z.number().int().positive().default(10),
      })
      .default(() => ({ total_minutes: 90, command_minutes: 20, idle_minutes: 10 })),
    pr: z
      .object({
        draft: z.boolean().default(false),
        publish: z.boolean().default(true),
      })
      .default(() => ({ draft: false, publish: true })),
    git: z
      .object({
        base: z.string().default("main"),
        author_name: z.string().default("Codex Cage"),
        author_email: z.string().email().default("codex-cage@users.noreply.github.com"),
      })
      .default(() => ({
        base: "main",
        author_name: "Codex Cage",
        author_email: "codex-cage@users.noreply.github.com",
      })),
    issue: z
      .object({
        comments: z.union([z.number().int().nonnegative(), z.literal("all")]).default(10),
      })
      .default(() => ({ comments: 10 })),
    guards: z
      .object({
        max_secret_fix_attempts: z.number().int().nonnegative().default(2),
      })
      .default(() => ({ max_secret_fix_attempts: 2 })),
  })
  .passthrough();

export type CodexCageConfig = z.infer<typeof codexCageConfigSchema>;

export type ConfigParseResult = {
  config: CodexCageConfig;
  warnings: string[];
};

const knownTopLevelKeys = new Set([
  "setup",
  "verify",
  "services",
  "runtime",
  "agent",
  "timeouts",
  "pr",
  "git",
  "issue",
  "guards",
]);

export function parseCodexCageConfig(input: unknown): ConfigParseResult {
  const warnings = collectUnknownTopLevelKeyWarnings(input);

  return {
    config: codexCageConfigSchema.parse(input),
    warnings,
  };
}

function collectUnknownTopLevelKeyWarnings(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }

  return Object.keys(input)
    .filter((key) => !knownTopLevelKeys.has(key))
    .map((key) => `Unknown config key "${key}" is not used by this version.`);
}
