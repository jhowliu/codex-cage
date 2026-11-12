import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Document, parseDocument } from "yaml";
import {
  parseAgentCageConfig,
  type AgentCageConfig,
  type ConfigParseResult,
} from "./config.js";

export const AGENT_CAGE_CONFIG_FILE = ".agent-cage.yml";

export const managedConfigKeys = [
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
  "execution",
  "actions",
] as const;

export type ManagedConfigKey = (typeof managedConfigKeys)[number];

export type AgentCageConfigUpdates = {
  readonly [Key in ManagedConfigKey]?: Exclude<AgentCageConfig[Key], undefined>;
};

export type MissingConfigFile = {
  status: "missing";
  path: string;
};

export type ValidConfigFile = ConfigParseResult & {
  status: "valid";
  path: string;
  document: Document;
};

export type InvalidConfigFile = {
  status: "invalid";
  path: string;
  document: Document;
  errors: readonly Error[];
};

export type AgentCageConfigFile = MissingConfigFile | ValidConfigFile | InvalidConfigFile;

export type WritableConfigFile = MissingConfigFile | ValidConfigFile;

export async function loadAgentCageConfigFile(cwd: string): Promise<AgentCageConfigFile> {
  const path = join(cwd, AGENT_CAGE_CONFIG_FILE);
  const source = await readOptionalFile(path);
  if (source === undefined) {
    return { status: "missing", path };
  }

  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return { status: "invalid", path, document, errors: document.errors };
  }

  try {
    const result = parseAgentCageConfig(document.toJS());
    return { status: "valid", path, document, ...result };
  } catch (error) {
    return { status: "invalid", path, document, errors: [toError(error)] };
  }
}

export async function updateAgentCageConfigFile(
  state: WritableConfigFile,
  updates: AgentCageConfigUpdates,
): Promise<ValidConfigFile> {
  const document = state.status === "valid" ? state.document.clone() : new Document({});

  for (const key of managedConfigKeys) {
    const value = updates[key];
    if (value !== undefined) {
      document.set(key, value);
    }
  }

  const result = parseAgentCageConfig(document.toJS());
  await atomicWrite(state.path, document.toString());

  return { status: "valid", path: state.path, document, ...result };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
