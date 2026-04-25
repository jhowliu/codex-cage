import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const instructionFileCandidates = [
  "AGENTS.md",
  ".codex-cage/instructions.md",
  ".github/copilot-instructions.md",
  "CLAUDE.md",
] as const;

export const instructionPromptLimitBytes = 32 * 1024;

export type InstructionFileStatus = "included" | "missing" | "truncated" | "skipped";

export type InstructionFileResult = {
  path: string;
  status: InstructionFileStatus;
  bytes: number;
  includedBytes: number;
};

export type PromptContext = {
  instructions: string;
  instructionFiles: InstructionFileResult[];
  limitBytes: number;
  truncated: boolean;
};

export async function buildPromptContext(cwd: string): Promise<PromptContext> {
  const instructionFiles: InstructionFileResult[] = [];
  const sections: string[] = [];
  let remainingBytes = instructionPromptLimitBytes;
  let truncated = false;

  for (const path of instructionFileCandidates) {
    const content = await readOptionalInstruction(cwd, path);

    if (content === null) {
      instructionFiles.push({
        path,
        status: "missing",
        bytes: 0,
        includedBytes: 0,
      });
      continue;
    }

    const contentBytes = Buffer.byteLength(content, "utf8");

    if (remainingBytes <= 0) {
      truncated = true;
      instructionFiles.push({
        path,
        status: "skipped",
        bytes: contentBytes,
        includedBytes: 0,
      });
      continue;
    }

    const sectionPrefix = `## ${path}\n\n`;
    const sectionOverheadBytes = Buffer.byteLength(sectionPrefix, "utf8");
    const contentLimit = Math.max(0, remainingBytes - sectionOverheadBytes);
    const limited = truncateUtf8(
      content,
      contentLimit,
      `\n\n[Instruction file truncated at ${contentLimit} bytes]\n`,
    );
    const section = `${sectionPrefix}${limited.content.trimEnd()}`;
    const sectionBytes = Buffer.byteLength(section, "utf8");

    remainingBytes = Math.max(0, remainingBytes - sectionBytes);
    truncated = truncated || limited.truncated;
    instructionFiles.push({
      path,
      status: limited.truncated ? "truncated" : "included",
      bytes: contentBytes,
      includedBytes: Buffer.byteLength(limited.content, "utf8"),
    });
    sections.push(section);
  }

  return {
    instructions: sections.join("\n\n"),
    instructionFiles,
    limitBytes: instructionPromptLimitBytes,
    truncated,
  };
}

export function formatInstructionsForPrompt(context: PromptContext): string {
  if (context.instructions === "") {
    return "";
  }

  return `Repository instructions:
Follow these repository-specific instructions when they apply. If source files or tests conflict with this context, treat the source files and tests as authoritative.

${context.instructions}`;
}

async function readOptionalInstruction(
  cwd: string,
  path: string,
): Promise<string | null> {
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function truncateUtf8(
  value: string,
  limitBytes: number,
  marker: string,
): { content: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= limitBytes) {
    return { content: value, truncated: false };
  }

  let content = value;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentLimit = Math.max(0, limitBytes - markerBytes);

  while (Buffer.byteLength(content, "utf8") > contentLimit) {
    content = content.slice(0, -1);
  }

  return { content: `${content}${marker}`, truncated: true };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
