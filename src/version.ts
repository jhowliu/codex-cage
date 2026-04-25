import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  version?: unknown;
};

export function readPackageVersion(): string {
  const packagePath = findPackageJson(dirname(fileURLToPath(import.meta.url)));
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;

  if (typeof packageJson.version !== "string") {
    return "0.0.0";
  }

  return packageJson.version;
}

function findPackageJson(startDir: string): string {
  let currentDir = startDir;

  while (currentDir !== dirname(currentDir)) {
    const candidate = join(currentDir, "package.json");

    if (existsSync(candidate)) {
      return candidate;
    }

    currentDir = dirname(currentDir);
  }

  return join(startDir, "package.json");
}
