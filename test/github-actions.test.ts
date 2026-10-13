import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import {
  generateGitHubActionsWorkflow,
  type GitHubActionsWorkflowInput,
} from "../src/github-actions.js";

type WorkflowStep = {
  name: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type Workflow = {
  on: Record<string, unknown>;
  jobs: {
    run: {
      env: Record<string, string>;
      container?: Record<string, unknown>;
      services?: Record<string, Record<string, unknown>>;
      steps: WorkflowStep[];
      concurrency: Record<string, unknown>;
      "timeout-minutes": number;
    };
  };
};

function generate(input: Partial<GitHubActionsWorkflowInput> = {}): {
  yaml: string;
  workflow: Workflow;
} {
  const yaml = generateGitHubActionsWorkflow({
    codexCageVersion: "1.2.3",
    ...input,
  });
  return { yaml, workflow: parse(yaml) as Workflow };
}

function step(workflow: Workflow, name: string): WorkflowStep {
  const found = workflow.jobs.run.steps.find((candidate) => candidate.name === name);
  assert.ok(found, `missing step: ${name}`);
  return found;
}

test("generates a parseable issue-label and dispatch workflow for the target checkout", () => {
  const { workflow } = generate();

  assert.deepEqual(workflow.on.issues, { types: ["labeled"] });
  assert.ok(workflow.on.workflow_dispatch);
  assert.equal(workflow.jobs.run.env.CODEX_CAGE_EXECUTION, "direct");
  assert.match(String(workflow.jobs.run.concurrency.group), /issue/);
  assert.equal(workflow.jobs.run.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.run["timeout-minutes"], 90);
  assert.deepEqual(step(workflow, "Check out target repository"), {
    name: "Check out target repository",
    uses: "actions/checkout@v4",
  });
  assert.equal(
    step(workflow, "Install Codex Cage and Codex CLI").run,
    'npm install --global --no-audit --no-fund "codex-cage@1.2.3" "@openai/codex@0.125.0"',
  );
});

test("scopes credentials to credential and issue-management steps", () => {
  const { workflow } = generate();
  const job = workflow.jobs.run;
  const credentialStep = step(workflow, "Write Codex Cage credentials");
  const cleanupStep = step(workflow, "Remove Codex Cage credentials");

  assert.equal(JSON.stringify(job.env).includes("secrets."), false);
  assert.match(credentialStep.env?.OPENAI_API_KEY ?? "", /secrets\.OPENAI_API_KEY/);
  assert.match(
    credentialStep.env?.CODEX_CAGE_GITHUB_TOKEN ?? "",
    /secrets\.CODEX_CAGE_GITHUB_TOKEN/,
  );
  assert.match(credentialStep.run ?? "", /chmod 600 \.codex-cage\.env/);
  assert.equal(cleanupStep.if, "always()");
  assert.equal(cleanupStep.run, "rm -f .codex-cage.env");

  for (const candidate of job.steps) {
    const serialized = JSON.stringify(candidate);
    if (serialized.includes("secrets.CODEX_CAGE_GITHUB_TOKEN")) {
      assert.match(candidate.name, /credentials|Normalize|Report|Clear/);
    }
  }
});

test("normalizes all state labels and reports results and artifacts", () => {
  const { workflow } = generate();
  const expectedLabels = [
    "codex-cage:run",
    "codex-cage:in-progress",
    "codex-cage:ready-for-review",
    "codex-cage:blocked",
  ];

  for (const name of [
    "Normalize labels and mark issue in progress",
    "Report success",
    "Report failure",
  ]) {
    const run = step(workflow, name).run ?? "";
    for (const label of expectedLabels) assert.match(run, new RegExp(label));
  }

  assert.match(step(workflow, "Report success").run ?? "", /prUrl/);
  assert.match(step(workflow, "Report failure").run ?? "", /failureCode/);
  const artifact = step(workflow, "Upload run artifacts");
  assert.equal(artifact.if, "always()");
  assert.match(artifact.with?.path ?? "", /codex-cage-result\.json/);
  assert.match(artifact.with?.path ?? "", /\.codex-cage\/runs/);
});

test("renders an optional job container and generic services", () => {
  const { workflow } = generate({
    timeoutMinutes: 45,
    container: {
      image: "node:22",
      env: { LANG: "C.UTF-8" },
      ports: ["8080"],
      options: "--cpus 2",
    },
    services: {
      postgres: {
        image: "postgres:17",
        env: { POSTGRES_PASSWORD: "test" },
        ports: ["5432:5432"],
        options: "--health-cmd pg_isready",
      },
    },
  });

  assert.equal(workflow.jobs.run["timeout-minutes"], 45);
  assert.deepEqual(workflow.jobs.run.container, {
    image: "node:22",
    env: { LANG: "C.UTF-8" },
    ports: ["8080"],
    options: "--cpus 2",
  });
  assert.deepEqual(workflow.jobs.run.services?.postgres, {
    image: "postgres:17",
    env: { POSTGRES_PASSWORD: "test" },
    ports: ["5432:5432"],
    options: "--health-cmd pg_isready",
  });
});

test("rejects versions that are not exact", () => {
  assert.throws(
    () => generateGitHubActionsWorkflow({ codexCageVersion: "latest" }),
    /exact semantic version/,
  );
  assert.throws(
    () => generateGitHubActionsWorkflow({ codexCageVersion: "^1.2.3" }),
    /exact semantic version/,
  );
});
