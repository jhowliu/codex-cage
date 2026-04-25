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
      })
      .default(() => ({ draft: false })),
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

export type RuntimeImageWarning = {
  code: "runtime_image_latest_tag" | "runtime_image_missing_tag_or_digest";
  image: string;
  message: string;
};

export type ConfigParseResult = {
  config: CodexCageConfig;
  warnings: string[];
  runtimeImageWarnings: RuntimeImageWarning[];
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
  const config = codexCageConfigSchema.parse(input);
  const runtimeImageWarnings = collectRuntimeImageWarnings(config);

  return {
    config,
    runtimeImageWarnings,
    warnings: [
      ...collectUnknownTopLevelKeyWarnings(input),
      ...runtimeImageWarnings.map((warning) => warning.message),
    ],
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

function collectRuntimeImageWarnings(config: CodexCageConfig): RuntimeImageWarning[] {
  if (config.runtime.dockerfile !== null) {
    return [];
  }

  const reference = parseDockerImageReference(config.runtime.image);

  if (reference.digest !== null) {
    return [];
  }

  if (reference.tag === null) {
    return [
      {
        code: "runtime_image_missing_tag_or_digest",
        image: config.runtime.image,
        message: `runtime.image "${config.runtime.image}" has no explicit tag or digest; use a pinned tag or digest for reproducible runs.`,
      },
    ];
  }

  if (reference.tag.toLowerCase() === "latest") {
    return [
      {
        code: "runtime_image_latest_tag",
        image: config.runtime.image,
        message: `runtime.image "${config.runtime.image}" uses the mutable "latest" tag; use a pinned tag or digest for reproducible runs.`,
      },
    ];
  }

  return [];
}

function parseDockerImageReference(image: string): {
  tag: string | null;
  digest: string | null;
} {
  const digestSeparatorIndex = image.indexOf("@");
  const nameAndTag =
    digestSeparatorIndex === -1 ? image : image.slice(0, digestSeparatorIndex);
  const digest =
    digestSeparatorIndex === -1 ? null : image.slice(digestSeparatorIndex + 1);
  const lastSlashIndex = nameAndTag.lastIndexOf("/");
  const lastColonIndex = nameAndTag.lastIndexOf(":");

  return {
    tag: lastColonIndex > lastSlashIndex ? nameAndTag.slice(lastColonIndex + 1) : null,
    digest,
  };
}
