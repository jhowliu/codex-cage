# Security Assumptions And Threat Model

Codex Cage is built for running Codex against a repository you already trust enough to execute locally in Docker. It is not a general sandbox for hostile repositories, hostile build scripts, or hostile maintainers.

Read this before running `codex-cage run` on a repository.

## Trusted Target Repository Model

The target repository is trusted input. Codex Cage clones it into a Docker volume instead of bind mounting your host checkout, but the repository still controls executable files that Codex Cage may run.

Treat these files and commands as trust boundaries:

- `.codex-cage.yml`
- Docker Compose files referenced by `.codex-cage.yml`
- runtime Dockerfiles referenced by `.codex-cage.yml`
- `setup` commands
- `verify` commands
- package manager scripts, build scripts, test scripts, hooks, and other programs reached by setup or verification

If a repository is malicious, it can write code that runs during setup, verification, tests, build steps, Compose startup, or runtime image builds. Codex Cage reduces host filesystem exposure, but it does not make those actions safe to run from an untrusted repository.

## What Codex Cage Protects

Codex Cage's default runtime avoids several common host exposure paths:

- It does not bind mount the host working tree.
- It does not mount the Docker socket into the agent container.
- It does not mount host SSH config.
- It does not mount GitHub CLI config.
- It does not publish host ports by default.
- Agent commands run as the non-root `agent` user.
- Workspace state lives in Docker-managed per-run volumes.
- Managed Docker resources are labeled for cleanup.
- Diffs are scanned for injected secret values, high-confidence token patterns, private keys, and sensitive auth files before publishing.

These boundaries are useful for accidental damage and ordinary agent mistakes. They are not a proof that arbitrary code cannot escape, exfiltrate data, abuse tokens, or attack the local Docker daemon or kernel.

## What Remains Trusted

The runtime image is part of the trusted computing base. This includes the default `ghcr.io/jhowliu/codex-cage/base:<version>` image and any custom image selected with `runtime.image`.

If `runtime.dockerfile` is configured, the Dockerfile and its build context are also trusted. Dockerfile instructions execute during image build and may download packages, run shell commands, and produce a runtime environment that all later agent commands inherit.

Docker Compose files are trusted. Compose services can run arbitrary images and commands, can receive network access, and can expose behavior to the agent container over the run network.

The local Docker daemon, host kernel, Docker networking stack, and container runtime are trusted infrastructure. Codex Cage does not defend against vulnerabilities or misconfiguration in those layers.

## Credentials

Use the smallest useful credentials.

Recommended GitHub token:

- Use a fine-grained personal access token.
- Scope it only to the target repository.
- Grant **Contents: Read and write** for clone, branch push, and commit publishing.
- Grant **Issues: Read-only** for GitHub issue context.
- Grant **Pull requests: Read and write** for PR creation.
- Keep **Metadata: Read-only**, which GitHub requires for repository access.
- Do not use organization-wide, all-repository, admin, workflow, package, or secret-management permissions unless the target repository explicitly needs them and you accept that risk.

`.codex-cage.env` is read by the host orchestrator and must not be committed. Known secret values are redacted from logs, and secret-looking diff content is blocked before publishing, but commands in the trusted target repository may still receive and use configured credentials.

Current credential behavior is run-scoped, not phase-scoped. Non-empty values from `.codex-cage.env` are passed as environment variables to the Docker-run commands used for clone, setup, implementation, verification, and review. `GITHUB_TOKEN` is also mirrored to `GH_TOKEN` when `GH_TOKEN` is not set. `OPENAI_API_KEY` is passed when present; if it is absent and a local Codex auth file is found, that auth file is mounted read-only and copied into the agent user's Codex config inside the container.

When phase-scoped credential behavior is implemented, this document should be updated to state exactly which credentials are available to each phase. Until then, assume repository-controlled setup and verification commands can access the run credentials supplied in `.codex-cage.env`.

## Network Egress

Network egress remains enabled by default. Setup commands, verification commands, package managers, Compose services, runtime image builds, and agent commands may reach external networks unless your Docker daemon, host firewall, Compose configuration, or custom runtime image prevents it.

Do not run Codex Cage on a repository if the available credentials or local network position would make outbound exfiltration unacceptable.

## Independent Review

Independent review is a quality-control step, not a security boundary.

The reviewer gets a fresh read-only Codex run over the issue context, diff, verification summary, and result metadata. It can catch bugs, missing requirements, suspicious changes, and weak verification. It does not prevent malicious setup scripts, malicious verification scripts, compromised runtime images, network exfiltration, or Docker/container escapes.

## Run Artifacts

Run artifacts are sensitive local data.

Codex Cage stores run metadata in `.codex-cage/codex-cage.sqlite` and larger artifacts under `.codex-cage/runs/<run-id>`. Artifacts can include prompts, rendered repository instructions, issue payloads, logs, patches, summaries, review reports, resolved configuration, and publish metadata.

These files may reveal issue details, repository structure, generated code, command output, and redacted references to secrets. They are ignored by the generated `.gitignore`, but cleanup does not delete them. Protect them like local development logs, and delete them manually when retention is no longer needed.

## Out Of Scope

Codex Cage does not claim to provide:

- a sandbox for arbitrary untrusted repositories
- protection from malicious Dockerfiles, Compose files, package scripts, setup commands, or verify commands
- protection from Docker daemon, container runtime, kernel, or hardware vulnerabilities
- prevention of network egress by default
- cloud IAM management, token rotation, or secret revocation
- assurance that independent review will detect malicious or vulnerable code
- secure retention, encryption, or automatic deletion of local run artifacts
