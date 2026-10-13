import { stringify } from "yaml";

export type GitHubActionsLabels = {
  run: string;
  inProgress: string;
  ready: string;
  blocked: string;
};

export type GitHubActionsRuntime = {
  image: string;
  env?: Readonly<Record<string, string>>;
  ports?: readonly string[];
  options?: string;
};

export type GitHubActionsWorkflowInput = {
  codexCageVersion: string;
  labels?: Partial<GitHubActionsLabels>;
  name?: string;
  runsOn?: string;
  timeoutMinutes?: number;
  container?: GitHubActionsRuntime;
  services?: Readonly<Record<string, GitHubActionsRuntime>>;
};

const defaultLabels = {
  run: "codex-cage:run",
  inProgress: "codex-cage:in-progress",
  ready: "codex-cage:ready-for-review",
  blocked: "codex-cage:blocked",
} satisfies GitHubActionsLabels;

const codexCliVersion = "0.125.0";
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const labelPattern = /^[0-9A-Za-z][0-9A-Za-z .:/_-]*$/;

export function generateGitHubActionsWorkflow(input: GitHubActionsWorkflowInput): string {
  assertInput(input);
  const labels: GitHubActionsLabels = { ...defaultLabels, ...input.labels };
  const issueNumber = expression("github.event.issue.number || inputs.issue_number");
  const issueUrl = expression(
    "github.event.issue.html_url || format('{0}/{1}/issues/{2}', github.server_url, github.repository, inputs.issue_number)",
  );
  const runUrl = expression(
    "format('{0}/{1}/actions/runs/{2}', github.server_url, github.repository, github.run_id)",
  );
  const managementEnv = {
    GH_TOKEN: expression("secrets.CODEX_CAGE_GITHUB_TOKEN"),
    ISSUE_NUMBER: issueNumber,
  };

  const job: Record<string, unknown> = {
    if: expression(
      `github.event_name == 'workflow_dispatch' || github.event.label.name == '${labels.run}'`,
    ),
    "runs-on": input.runsOn ?? "ubuntu-latest",
    "timeout-minutes": input.timeoutMinutes ?? 90,
    concurrency: {
      group: `codex-cage-issue-${issueNumber}`,
      "cancel-in-progress": false,
    },
    env: {
      CODEX_CAGE_EXECUTION: "direct",
      ISSUE_NUMBER: issueNumber,
      ISSUE_URL: issueUrl,
      RUN_URL: runUrl,
      RESULT_JSON: expression("format('{0}/codex-cage-result.json', runner.temp)"),
    },
    steps: [
      {
        name: "Validate credentials",
        env: {
          OPENAI_API_KEY: expression("secrets.OPENAI_API_KEY"),
          CODEX_CAGE_GITHUB_TOKEN: expression("secrets.CODEX_CAGE_GITHUB_TOKEN"),
        },
        run: [
          'test -n "$OPENAI_API_KEY" || { printf "Missing OPENAI_API_KEY\\n" >&2; exit 1; }',
          'test -n "$CODEX_CAGE_GITHUB_TOKEN" || { printf "Missing CODEX_CAGE_GITHUB_TOKEN\\n" >&2; exit 1; }',
        ].join("\n"),
      },
      {
        name: "Normalize labels and mark issue in progress",
        env: managementEnv,
        run: labelCommand(labels, labels.inProgress),
      },
      {
        name: "Check out target repository",
        uses: "actions/checkout@v4",
      },
      {
        name: "Set up Node.js",
        uses: "actions/setup-node@v4",
        with: { "node-version": "22" },
      },
      {
        name: "Install Codex Cage and Codex CLI",
        run: `npm install --global --no-audit --no-fund "codex-cage@${input.codexCageVersion}" "@openai/codex@${codexCliVersion}"`,
      },
      {
        name: "Write Codex Cage credentials",
        env: {
          OPENAI_API_KEY: expression("secrets.OPENAI_API_KEY"),
          CODEX_CAGE_GITHUB_TOKEN: expression("secrets.CODEX_CAGE_GITHUB_TOKEN"),
        },
        run: [
          "umask 077",
          'printf \'OPENAI_API_KEY=%s\\nGITHUB_TOKEN=%s\\n\' "$OPENAI_API_KEY" "$CODEX_CAGE_GITHUB_TOKEN" > .codex-cage.env',
          "chmod 600 .codex-cage.env",
        ].join("\n"),
      },
      {
        name: "Run Codex Cage",
        run: 'codex-cage run "$ISSUE_URL" --verbose --result-json "$RESULT_JSON"',
      },
      {
        name: "Report success",
        if: "success()",
        env: managementEnv,
        run: [
          "PR_URL=$(jq -r '.prUrl // empty' \"$RESULT_JSON\")",
          'BODY="Codex Cage completed successfully. [View result](${RUN_URL})."',
          'if [ -n "$PR_URL" ]; then BODY="${BODY} [Open pull request](${PR_URL})."; fi',
          'gh issue comment "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --body "$BODY"',
          labelCommand(labels, labels.ready),
        ].join("\n"),
      },
      {
        name: "Report failure",
        if: "failure()",
        env: managementEnv,
        run: [
          'FAILURE_CODE=$(jq -r \'.failureCode // "unknown"\' "$RESULT_JSON" 2>/dev/null || printf unknown)',
          'BODY="Codex Cage failed (\\`${FAILURE_CODE}\\`). [View result](${RUN_URL})."',
          "RUN_ID=$(jq -r '.runId // empty' \"$RESULT_JSON\" 2>/dev/null || true)",
          'SUMMARY_FILE=".codex-cage/runs/${RUN_ID}/summary.md"',
          'if [ -n "$RUN_ID" ] && [ -f "$SUMMARY_FILE" ]; then BODY="${BODY}"$\'\\n\\n\'"$(cat "$SUMMARY_FILE")"; fi',
          'gh issue comment "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --body "$BODY"',
          labelCommand(labels, labels.blocked),
        ].join("\n"),
      },
      {
        name: "Upload run artifacts",
        if: "always()",
        uses: "actions/upload-artifact@v4",
        with: {
          name: `codex-cage-run-${issueNumber}`,
          path: [
            ".codex-cage/runs/",
            expression("runner.temp") + "/codex-cage-result.json",
          ].join("\n"),
          "if-no-files-found": "ignore",
        },
      },
      {
        name: "Remove Codex Cage credentials",
        if: "always()",
        run: "rm -f .codex-cage.env",
      },
      {
        name: "Clear in-progress label",
        if: "always()",
        env: managementEnv,
        run: `gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --remove-label '${labels.inProgress}' || true`,
      },
    ],
  };

  if (input.container !== undefined) {
    job.container = runtimeConfig(input.container);
  }
  if (input.services !== undefined) {
    job.services = Object.fromEntries(
      Object.entries(input.services).map(([name, service]) => [
        name,
        runtimeConfig(service),
      ]),
    );
  }

  return stringify(
    {
      name: input.name ?? "Codex Cage issue run",
      on: {
        issues: { types: ["labeled"] },
        workflow_dispatch: {
          inputs: {
            issue_number: {
              description: "Issue number to implement",
              required: true,
              type: "string",
            },
          },
        },
      },
      permissions: { contents: "read" },
      jobs: { run: job },
    },
    { lineWidth: 0 },
  );
}

function expression(value: string): string {
  return `\${{ ${value} }}`;
}

function labelCommand(labels: GitHubActionsLabels, add: string): string {
  return [
    ...[labels.run, labels.inProgress, labels.ready, labels.blocked].map(
      (label) =>
        `gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --remove-label '${label}' || true`,
    ),
    `gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --add-label '${add}'`,
  ].join("\n");
}

function runtimeConfig(runtime: GitHubActionsRuntime): Record<string, unknown> {
  const result: Record<string, unknown> = { image: runtime.image };
  if (runtime.env !== undefined) result.env = { ...runtime.env };
  if (runtime.ports !== undefined) result.ports = [...runtime.ports];
  if (runtime.options !== undefined) result.options = runtime.options;
  return result;
}

function assertInput(input: GitHubActionsWorkflowInput): void {
  if (!versionPattern.test(input.codexCageVersion)) {
    throw new Error("codexCageVersion must be an exact semantic version.");
  }
  if (
    input.timeoutMinutes !== undefined &&
    (!Number.isInteger(input.timeoutMinutes) || input.timeoutMinutes < 1)
  ) {
    throw new Error("timeoutMinutes must be a positive integer.");
  }

  const labels = { ...defaultLabels, ...input.labels };
  for (const [name, label] of Object.entries(labels)) {
    if (!labelPattern.test(label)) {
      throw new Error(`${name} label contains unsupported characters.`);
    }
  }
}
