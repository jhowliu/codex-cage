import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDependencyChanges,
  formatDependencyChangesMarkdown,
} from "../src/dependencies.js";

test("classifyDependencyChanges detects dependency manifests and lockfiles", () => {
  const summary = classifyDependencyChanges(`diff --git a/package.json b/package.json
index 123..456 100644
--- a/package.json
+++ b/package.json
@@ -1 +1,2 @@
 {}
+{"dependencies":{}}
diff --git a/src/app.ts b/src/app.ts
index 123..456 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
 export const ok = true;
+export const changed = true;
diff --git a/package-lock.json b/package-lock.json
index 123..456 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1,2 @@
 {}
+{"lockfileVersion":3}
diff --git a/apps/web/pnpm-lock.yaml b/apps/web/pnpm-lock.yaml
index 123..456 100644
--- a/apps/web/pnpm-lock.yaml
+++ b/apps/web/pnpm-lock.yaml
@@ -1 +1,2 @@
 lockfileVersion: 9
+packages: {}
`);

  assert.deepEqual(summary, {
    changed: true,
    files: [
      { path: "apps/web/pnpm-lock.yaml", kind: "lockfile" },
      { path: "package-lock.json", kind: "lockfile" },
      { path: "package.json", kind: "manifest" },
    ],
  });
});

test("classifyDependencyChanges reports no dependency changes for unrelated diffs", () => {
  assert.deepEqual(
    classifyDependencyChanges(`diff --git a/src/app.ts b/src/app.ts
@@ -1 +1,2 @@
 export const ok = true;
+export const changed = true;
`),
    {
      changed: false,
      files: [],
    },
  );
});

test("formatDependencyChangesMarkdown is concise for PRs and artifacts", () => {
  assert.equal(
    formatDependencyChangesMarkdown({
      changed: true,
      files: [{ path: "pnpm-lock.yaml", kind: "lockfile" }],
    }),
    "- `pnpm-lock.yaml` (lockfile)",
  );
  assert.equal(
    formatDependencyChangesMarkdown({ changed: false, files: [] }),
    "- None detected.",
  );
});
