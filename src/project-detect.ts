import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Toolchains the Agent Cage base image (node:22-bookworm) lacks. Listed in the
 * order their Dockerfile snippets are emitted; later entries may rely on
 * earlier ones (poetry is installed with uv, maven runs on the JDK).
 */
export const projectToolchains = [
  "corepack",
  "python",
  "uv",
  "poetry",
  "go",
  "rust",
  "jdk",
  "maven",
] as const;

export type ProjectToolchain = (typeof projectToolchains)[number];

export type ProjectEcosystem = "node" | "python" | "go" | "rust" | "java" | "make";

export type ProjectDetection = {
  ecosystems: ProjectEcosystem[];
  setup: string[];
  verify: string[];
  toolchains: ProjectToolchain[];
};

/** Read-only view of the repo root, so detection can be tested without a disk. */
export type ProjectFiles = {
  exists(name: string): Promise<boolean>;
  read(name: string): Promise<string | null>;
};

type EcosystemDetection = {
  ecosystem: ProjectEcosystem;
  setup: string[];
  verify: string[];
  toolchains: ProjectToolchain[];
};

export function projectFilesAt(cwd: string): ProjectFiles {
  return {
    async exists(name) {
      try {
        await access(join(cwd, name));
        return true;
      } catch {
        return false;
      }
    },
    async read(name) {
      try {
        return await readFile(join(cwd, name), "utf8");
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * Detects setup and verification commands from files at the repo root. Every
 * matching ecosystem contributes (a Node + Go repo runs both test suites);
 * `make test` is used only when nothing else supplies a verification command.
 */
export async function detectProject(files: ProjectFiles): Promise<ProjectDetection> {
  const detections: EcosystemDetection[] = [];
  for (const detect of [detectNode, detectPython, detectGo, detectRust, detectJava]) {
    const detection = await detect(files);
    if (detection !== null) detections.push(detection);
  }
  if (detections.every((detection) => detection.verify.length === 0)) {
    const make = await detectMake(files);
    if (make !== null) detections.push(make);
  }

  const toolchains = new Set(detections.flatMap((detection) => detection.toolchains));
  return {
    ecosystems: detections.map((detection) => detection.ecosystem),
    setup: detections.flatMap((detection) => detection.setup),
    verify: detections.flatMap((detection) => detection.verify),
    toolchains: projectToolchains.filter((toolchain) => toolchains.has(toolchain)),
  };
}

async function detectNode(files: ProjectFiles): Promise<EcosystemDetection | null> {
  const packageJsonText = await files.read("package.json");
  if (packageJsonText === null) return null;
  const packageJson = parsePackageJson(packageJsonText);

  const manager = await nodePackageManager(files, packageJson.packageManager);
  return {
    ecosystem: "node",
    setup: [manager.setup],
    verify: nodeVerifyCommands(manager.run, packageJson.scripts),
    toolchains: manager.toolchains,
  };
}

async function nodePackageManager(
  files: ProjectFiles,
  packageManagerField: string | undefined,
): Promise<{ setup: string; run: string; toolchains: ProjectToolchain[] }> {
  if (await files.exists("pnpm-lock.yaml")) {
    return {
      setup: "pnpm install --frozen-lockfile",
      run: "pnpm",
      toolchains: ["corepack"],
    };
  }
  if (await files.exists("yarn.lock")) {
    // Yarn 1 ships with the Node image; Yarn 2+ (Berry) comes from corepack.
    const berry =
      (await files.exists(".yarnrc.yml")) ||
      /^yarn@[2-9]/.test(packageManagerField ?? "");
    return berry
      ? { setup: "yarn install --immutable", run: "yarn", toolchains: ["corepack"] }
      : { setup: "yarn install --frozen-lockfile", run: "yarn", toolchains: [] };
  }
  if (await files.exists("package-lock.json")) {
    return { setup: "npm ci", run: "npm run", toolchains: [] };
  }
  // Without a lockfile, install without creating one so it never lands in the PR.
  return { setup: "npm install --no-package-lock", run: "npm run", toolchains: [] };
}

function nodeVerifyCommands(
  runPrefix: string,
  scripts: Record<string, string>,
): string[] {
  if (scripts.test !== undefined) {
    return [runPrefix === "npm run" ? "npm test" : `${runPrefix} test`];
  }
  if (scripts.typecheck !== undefined) return [`${runPrefix} typecheck`];
  if (scripts.build !== undefined) return [`${runPrefix} build`];
  return [];
}

function parsePackageJson(text: string): {
  scripts: Record<string, string>;
  packageManager: string | undefined;
} {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { scripts: {}, packageManager: undefined };
  }
  const scripts = "scripts" in parsed ? parsed.scripts : undefined;
  const packageManager = "packageManager" in parsed ? parsed.packageManager : undefined;
  return {
    scripts:
      scripts === null || typeof scripts !== "object" || Array.isArray(scripts)
        ? {}
        : Object.fromEntries(
            Object.entries(scripts).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
    packageManager: typeof packageManager === "string" ? packageManager : undefined,
  };
}

// Python environments live in $HOME, outside the cloned workspace, so a
// virtualenv is never committed into the pull request.
const pythonVenv = "$HOME/.venv";

async function detectPython(files: ProjectFiles): Promise<EcosystemDetection | null> {
  if (await files.exists("uv.lock")) {
    return {
      ecosystem: "python",
      setup: ["uv sync --frozen"],
      verify: ["uv run pytest"],
      toolchains: ["uv"],
    };
  }
  if (await files.exists("poetry.lock")) {
    return {
      ecosystem: "python",
      setup: ["poetry install"],
      verify: ["poetry run pytest"],
      toolchains: ["uv", "poetry"],
    };
  }
  if (await files.exists("requirements.txt")) {
    return {
      ecosystem: "python",
      setup: [
        `python3 -m venv "${pythonVenv}" && "${pythonVenv}/bin/pip" install -r requirements.txt`,
      ],
      verify: [`"${pythonVenv}/bin/python" -m pytest`],
      toolchains: ["python"],
    };
  }
  return null;
}

async function detectGo(files: ProjectFiles): Promise<EcosystemDetection | null> {
  if (!(await files.exists("go.mod"))) return null;
  return {
    ecosystem: "go",
    setup: ["go mod download"],
    verify: ["go test ./..."],
    toolchains: ["go"],
  };
}

async function detectRust(files: ProjectFiles): Promise<EcosystemDetection | null> {
  if (!(await files.exists("Cargo.toml"))) return null;
  return {
    ecosystem: "rust",
    setup: ["cargo fetch"],
    verify: ["cargo test"],
    toolchains: ["rust"],
  };
}

async function detectJava(files: ProjectFiles): Promise<EcosystemDetection | null> {
  if (await files.exists("pom.xml")) {
    return (await files.exists("mvnw"))
      ? { ecosystem: "java", setup: [], verify: ["./mvnw -B test"], toolchains: ["jdk"] }
      : {
          ecosystem: "java",
          setup: [],
          verify: ["mvn -B test"],
          toolchains: ["jdk", "maven"],
        };
  }
  const gradle =
    (await files.exists("build.gradle")) || (await files.exists("build.gradle.kts"));
  if (gradle && (await files.exists("gradlew"))) {
    return {
      ecosystem: "java",
      setup: [],
      verify: ["./gradlew test"],
      toolchains: ["jdk"],
    };
  }
  return null;
}

async function detectMake(files: ProjectFiles): Promise<EcosystemDetection | null> {
  const makefile = await files.read("Makefile");
  if (makefile === null || !/^test\s*:/m.test(makefile)) return null;
  return { ecosystem: "make", setup: [], verify: ["make test"], toolchains: [] };
}

type ToolchainSnippet = {
  lines: readonly string[];
  /** Directories to prepend to PATH (binaries outside /usr/local/bin). */
  paths?: readonly string[];
};

const toolchainSnippets: Record<ProjectToolchain, ToolchainSnippet> = {
  corepack: { lines: ["ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0", "RUN corepack enable"] },
  python: {
    lines: [
      "RUN apt-get update \\",
      "  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \\",
      "  && rm -rf /var/lib/apt/lists/*",
    ],
  },
  uv: {
    lines: [
      "COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/",
      "ENV UV_PROJECT_ENVIRONMENT=/home/agent/.venv UV_LINK_MODE=copy",
    ],
  },
  poetry: {
    lines: [
      "RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install poetry",
    ],
  },
  go: {
    lines: ["COPY --from=golang:1-bookworm /usr/local/go /usr/local/go"],
    paths: ["/usr/local/go/bin", "/home/agent/go/bin"],
  },
  rust: {
    lines: [
      "COPY --from=rust:1-bookworm --chown=agent:agent /usr/local/rustup /usr/local/rustup",
      "COPY --from=rust:1-bookworm --chown=agent:agent /usr/local/cargo /usr/local/cargo",
      "ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \\",
      "  CARGO_TARGET_DIR=/home/agent/cargo-target",
    ],
    paths: ["/usr/local/cargo/bin"],
  },
  jdk: {
    lines: [
      "COPY --from=eclipse-temurin:21-jdk /opt/java/openjdk /opt/java/openjdk",
      "ENV JAVA_HOME=/opt/java/openjdk",
    ],
    paths: ["/opt/java/openjdk/bin"],
  },
  maven: {
    lines: [
      "COPY --from=maven:3-eclipse-temurin-21 /usr/share/maven /usr/share/maven",
      "RUN ln -s /usr/share/maven/bin/mvn /usr/local/bin/mvn",
    ],
  },
};

/** Runtime Dockerfile that extends the sandbox image with the given toolchains. */
export function generateRuntimeDockerfile(
  baseImage: string,
  toolchains: readonly ProjectToolchain[],
): string {
  const ordered = projectToolchains.filter((toolchain) => toolchains.includes(toolchain));
  const paths = ordered.flatMap((toolchain) => toolchainSnippets[toolchain].paths ?? []);
  const pathLines =
    paths.length === 0
      ? []
      : [
          `ENV PATH=${paths.join(":")}:$PATH`,
          // The sandbox runs commands with `sh -lc`, and /etc/profile resets PATH
          // for login shells, so also export it from /etc/profile.d.
          `RUN echo 'export PATH="${paths.join(":")}:$PATH"' > /etc/profile.d/agent-cage-toolchains.sh`,
        ];
  return [
    `# Generated by \`agent-cage setup\` for: ${ordered.join(", ")}.`,
    "# Adds toolchains the Agent Cage base image lacks. Edit freely, and pin the",
    "# image tags below for reproducible runs.",
    `FROM ${baseImage}`,
    "",
    "USER root",
    ...ordered.flatMap((toolchain) => toolchainSnippets[toolchain].lines),
    ...pathLines,
    "USER agent",
    "",
  ].join("\n");
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EISDIR")
  );
}
