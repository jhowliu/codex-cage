import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSqliteExperimentalWarning } from "../src/node-warnings.js";

const modulePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "node-warnings.js",
);

test("isSqliteExperimentalWarning matches only the node:sqlite warning", () => {
  assert.equal(
    isSqliteExperimentalWarning(
      "SQLite is an experimental feature and might change at any time",
    ),
    true,
  );
  assert.equal(
    isSqliteExperimentalWarning(new Error("Something else is deprecated")),
    false,
  );
});

test("suppressSqliteExperimentalWarning hides the sqlite warning but keeps others", () => {
  const script = `
    const { suppressSqliteExperimentalWarning } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    suppressSqliteExperimentalWarning();
    await import("node:sqlite");
    process.emitWarning("keep this warning");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  assert.match(result.stderr, /keep this warning/);
});
