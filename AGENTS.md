# Agent Instructions

## TypeScript Coding Style

### Compiler Baseline

- Treat this as a strict TypeScript 5.x Node project. Keep `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`, and `noUnusedParameters` passing.
- Preserve the current ES2022, ESM, and NodeNext conventions. Include `.js` extensions in relative TypeScript imports that compile to runtime JavaScript.
- Use `import type` for imports that are only used as types.
- Do not weaken compiler options to make code pass. Fix the types or adjust the design.

### Type Modeling

- Prefer precise domain types over loose primitives. Use discriminated unions for state, result, phase, command intent, and failure-code variants instead of optional fields that allow impossible combinations.
- Use exhaustive `switch` handling for unions. Include a `never` assignment in the default branch when it improves coverage for future union members.
- Use branded string types for domain-specific IDs when confusing two string IDs would be a real bug, such as run IDs, issue identifiers, branch names, or Docker resource identifiers.
- Use template literal types for constrained string patterns when they encode meaningful structure, such as artifact filenames, phase-scoped keys, or generated branch names.
- Use `Record<K, V>` for object maps, and prefer a specific key union over `Record<string, V>` when the valid keys are known.
- Use `NoInfer<T>` when a fallback/default parameter must be constrained by an earlier argument instead of widening the inferred type.
- Model nullable values intentionally. Use `null` for known-empty serialized values and `undefined` for omitted optional fields; do not mix them casually.

### Narrowing And Validation

- Use `unknown` for untrusted data and narrow it with Zod schemas, type predicates, or explicit runtime checks before use. Do not use `any` unless there is no practical alternative, and keep the scope local.
- Prefer type predicates over type assertions when narrowing runtime values.
- Prefer Zod schemas at external boundaries: config files, JSON artifacts, command output, environment data, and issue-provider payloads.
- Prefer `satisfies` when validating object literals against a type. Avoid `as` assertions unless the code has already established the invariant and the compiler cannot express it.
- Use `as const` for fixed string lists, command names, phase names, failure codes, and other literal maps that should not widen to `string`.
- Keep public function inputs and outputs explicit when they define module boundaries. Let local variables infer types when inference is clear and safe.

### Runtime And Orchestration

- Keep async command execution explicit: capture stdout, stderr, exit code, redaction, timeout, and phase context where relevant instead of passing around raw process results.
- Prefer small pure helpers for parsing, validation, redaction, path construction, and formatting. Keep side effects in orchestration code.
- Do not swallow errors silently. Convert expected failures into typed failure codes or clear result objects; let unexpected programmer errors surface.
- Use deterministic resource cleanup. If introducing TypeScript `using`, first make sure the compiler libs and Node runtime support the Disposable protocol in this project; otherwise use explicit `try`/`finally`.
- Use the existing libraries already in the repo before adding dependencies: `zod` for validation, `yaml` for config parsing, `execa` for process execution, `commander` for CLI, and `node:test` for tests.

### Anti-Patterns

- Do not use `any` for convenience. Use `unknown` and narrow it.
- Do not use `as` to silence the compiler. Use `satisfies`, type predicates, schema parsing, or a narrower design.
- Do not use optional fields to model mutually exclusive states. Use discriminated unions.
- Do not add `// @ts-ignore` or `// @ts-expect-error` without a short comment explaining why the suppression is necessary.
- Do not introduce `enum`. Use `as const` objects, readonly arrays, and union types.
- Do not use the `Function` type. Write the actual function signature.
- Do not add broad string index signatures when `Record` with a specific key union can express the shape.

### Tests And Validation

- Keep tests close to behavior. For new run orchestration paths, add focused unit tests around command options, artifacts, status transitions, and failure codes.
- Run `npm run typecheck` and `npm test` for TypeScript changes. Run `npm run format` or a targeted Prettier check for touched files when repo-wide format is blocked by unrelated local files.
