# My Coding Agent

My Coding Agent is a small, safety-conscious coding agent. It uses NVIDIA Nemotron 3 Ultra automatically when an NVIDIA key is configured, with local Ollama Qwen as a private fallback. It accepts natural-language coding instructions and works only in a generated application workspace.

The agent source and generated applications are deliberately separate:

```text
my-agent/
├── src/                 # the coding agent itself
├── test/                # agent tests
└── projects/            # applications created by the agent
    ├── todo-app/
    └── portfolio/
```

The private dashboard also maintains its own small SQLite database at
`projects/.agent-data/task-history.sqlite`. It records only task outcome
metadata (time, active project, selected model route, duration, and status),
not task prompts or model responses. This needs no Supabase account, extra
package, or external network connection. The folder is hidden from the agent's
project list and is preserved by the Railway volume described below.

## Install and configure

Use Node.js 22.13 or later. This is the first Node 22 release where the built-in
SQLite module used for private task history no longer needs an experimental flag.

```bash
npm install
cp .env.example .env
```

Install [Ollama](https://ollama.com), then download the free local coding model
once:

```bash
npm run setup:ollama
```

Without an NVIDIA key, the automatic route uses `qwen2.5-coder:7b` through
Ollama on your Mac. It needs no provider key and keeps project content on this
computer. You can choose another installed local model in `.env`:

```dotenv
OLLAMA_MODEL=qwen2.5-coder:7b
```

### Automatic NVIDIA route

Add your private NVIDIA key to use Nemotron 3 Ultra automatically for Chat and
Projects. If NVIDIA is temporarily unavailable, the agent falls back to local
Qwen Coder. No per-task model selector is required.

```dotenv
NVIDIA_API_KEY=your_nvidia_api_key
```

The default NVIDIA catalog model ID is
`nvidia/nemotron-3-ultra-550b-a55b`. You can override the model or endpoint:

```dotenv
NVIDIA_NEMOTRON_ULTRA_MODEL=nvidia/nemotron-3-ultra-550b-a55b
NVIDIA_NEMOTRON_ULTRA_BASE_URL=https://integrate.api.nvidia.com/v1
```

### NVIDIA Safety Guard

The **NVIDIA Safety** toggle in the dashboard optionally checks each request
and final answer with `nvidia/nemotron-3.5-content-safety`. It is off by
default, so normal Chat and Project work remains local and fast. When enabled,
an unavailable or rate-limited NVIDIA request never stops the agent; it
continues with the existing local safeguards instead.

You can override the default catalog model or endpoint in `.env`:

```dotenv
NVIDIA_SAFETY_MODEL=nvidia/nemotron-3.5-content-safety
NVIDIA_SAFETY_BASE_URL=https://integrate.api.nvidia.com/v1
```

For unusually large multi-file tasks, you can raise the agent's step budget
from its default of 30 to a value between 10 and 100:

```dotenv
AGENT_MAX_STEPS=60
```

Higher budgets can complete longer tasks, but also increase latency and model
usage. The normal safety and verification gates still apply.

Each task also has a 15-minute wall-clock deadline so a stalled model or tool
cannot leave the dashboard working indefinitely. Completed changes are kept.
Set `AGENT_TASK_TIMEOUT_MS` to a value from 30,000 to 3,600,000 milliseconds
when a task needs a different limit.

### Optional Docker execution sandbox

By default, project checks run locally with a stripped environment. If Docker
Desktop is installed, set `AGENT_EXECUTION_MODE=docker` to run project tests,
builds, and focused Node checks in an isolated Node container instead. The
container has no network, drops Linux capabilities, uses a read-only root,
applies CPU/memory/process limits, and mounts only the active project. Package
installation remains local with lifecycle scripts disabled so dependencies can
be fetched deliberately before sandboxed checks run.

```dotenv
AGENT_EXECUTION_MODE=docker
```

Pull the default image once before using this mode:

```bash
docker pull node:22-alpine
```

Keep `.env` private. It is ignored by Git and unavailable to the agent's tools.

For a private hosted Docker deployment, also add a long, unique
`AGENT_UI_PASSWORD` (at least 16 characters). Leave the host and port settings
commented out for normal local use; the Docker image supplies its own safe
defaults.

## Start the agent

### Browser workspace

Start the local browser workspace:

```bash
npm run ui
```

Then open [http://127.0.0.1:3333](http://127.0.0.1:3333). It uses the automatic NVIDIA route when configured, otherwise local Ollama, and keeps the selected project active between tasks. The UI listens only on your computer; use `AGENT_UI_PORT` to choose another local port. Use **Cancel task** to stop a model request or command in progress; completed file changes are intentionally kept.

The dashboard separates **Chat** from **Projects**. Chat is for questions and
ideas and cannot inspect or alter project files. Projects is where the agent
creates, analyzes, edits, tests, previews, and delivers code.

The Workspace panel includes **Run project** for the active app. It starts a local preview on an unused port and provides an **Open** button. For safety, previews support projects whose `package.json` start script uses the form `node server.js`; the preview does not receive the agent's API key or other environment variables.

### VS Code companion extension

The repository also includes a local VS Code extension in
[`vscode-extension/`](vscode-extension/). It opens a focused agent panel in VS
Code, submits tasks to the same local dashboard, displays live task progress,
and lets you select the shared project or open the full browser workspace. It
does not run another agent server or store provider credentials.

Start the dashboard first, then package and install the extension:

```bash
npm run ui
cd vscode-extension
npx @vscode/vsce package
```

In VS Code, run **Extensions: Install from VSIX...** and choose the generated
`.vsix` file. Then use **Satyam's Agent: Open Agent Panel** from the Command
Palette. The extension connects to `http://127.0.0.1:3333` by default; set
`satyamsAgent.dashboardUrl` in VS Code Settings to change it. If you protect a
hosted dashboard with `AGENT_UI_PASSWORD`, run **Satyam's Agent: Set Dashboard
Password**. VS Code keeps that password in encrypted SecretStorage, not in
normal settings or the extension webview.

### Static web preview and source download

When the active project contains `public/index.html` or `index.html`, the
dashboard also offers **Open preview** and **Download source**. The preview opens
in a new browser tab and is
an isolated static HTML/CSS/browser-JavaScript view: it does not run a generated
Node server, share the dashboard origin, access agent APIs, or receive secrets.
It is protected by the same dashboard password. Projects that need a backend,
database, or environment variables should be deployed as their own service.

**Download source** creates a bounded `.tar.gz` source archive. It omits
dependencies, Git data, environment files, symlinks, and common credential/key
files. Do not hard-code credentials in ordinary source files.

The agent automatically retries transient model failures and uses the local
fallback when the configured NVIDIA route is unavailable.

### Research, browser checks, and project commands

The agent can search and read public web pages when current technical research
is needed. It blocks localhost, private-network addresses, redirects to private
addresses, embedded credentials, and non-text content. Web pages are treated as
untrusted references; the agent should read a relevant result before relying on
it and include the public URL in its final answer when it uses that research.

For static projects with `public/index.html` or `index.html`, the agent can run
an isolated Chromium visual check. It opens the page at desktop and mobile
sizes, captures temporary screenshots, checks responsive overflow, basic
accessibility signals, and browser/runtime errors, then discards the images.
Install Chromium once on each machine with
`npx playwright install chromium` before the agent runs visual checks.

The project terminal remains scoped to the active workspace and deliberately
does not accept arbitrary shell commands. Alongside `npm test` and `npm run
build`, it supports common project checks such as `npm run lint`, `npm run
typecheck`, `npm run check`, `npm run format:check`, `npm run test:unit`, `npm
run test:e2e`, plus focused `node --test` and `node --check` file checks.

After a task finishes, enter a follow-up instruction in the same box—for
example, “change the dashboard to a light theme” or “add export to the active
project.” The selected project remains active, and the dashboard keeps one
ongoing conversation across your tasks in private local storage so follow-up
work has context after a dashboard restart. It records only your task and the
final agent outcome—never hidden reasoning or tool output—and is kept separately
from task history. Use **Clear conversation** in the dashboard to remove the
saved transcript. Do not paste credentials into tasks;
common `key=value` and `password: value` patterns are redacted before storage.

### Full-stack application building

The agent is trained to build applications with a database, authentication,
deployment setup, and GitHub automation when the task calls for them. It
defaults to SQLite for local or single-instance apps, with validated,
parameterized data access and tested schema setup; Supabase is not required.
For shared production data, ask it to use your chosen Postgres provider.

For authentication, it is instructed to use hashed passwords, secure
server-side sessions, authorization checks, logout, and meaningful error
states—never plaintext passwords or browser-exposed secrets. Deployment work
includes a `.env.example`, health checks where relevant, and documented
database/persistent-storage requirements. GitHub changes are opt-in: the agent
will not create repositories, push code, or use a token without a confirmed
repository and explicit authorization.

### Optional GitHub source publishing

The dashboard can publish an active generated project to one existing GitHub
repository and initialized branch. It is deliberately disabled until you configure it. Create a
fine-grained GitHub token limited to that repository with **Contents: Read and
write**, then add the following secrets locally or in Railway's Variables tab:

```dotenv
GITHUB_TOKEN=github_pat_your_token
GITHUB_REPOSITORY=your-account/your-existing-repository
GITHUB_BRANCH=main
```

The dashboard shows the configured target and asks for a final confirmation
before every publish. Publishing adds or updates only safe project source
files in one atomic branch update; it omits environment files, tokens, keys,
dependencies, symlinks, and Git metadata, and never deletes remote files. It
does not create repositories, branches, pull requests, or GitHub Actions
secrets. Keep the token out of Git and do not paste it into a task prompt.

### Project intelligence

When you ask the agent to change an existing selected project, it locally
retrieves a small set of relevant source and documentation snippets before the
first model request. This keeps requests grounded in the active codebase
without a vector database or additional credentials. Retrieval excludes `.env`
files, Git data, dependencies, symlinks, and oversized files; retrieved source
is treated as untrusted data, never as instructions.

The dashboard also shows local **Project readiness** checks for the selected
project. They score implementation files, a valid `package.json`, behavior
tests with assertions, test/build commands, and optional README notes. This is
a deterministic engineering checklist—not a claim that the model or app is
fully correct—so use it alongside the agent's actual build and test results.

For a large, multi-phase, or full-stack new application, the agent now creates
a private milestone plan before implementation and updates it as milestones are
verified. Plans live under `projects/.agent-data/`, outside generated source,
downloads, and publishing. They give later tasks the active project's goal,
dependencies, and delivery progress without relying on one long chat context.
Milestones are only marked complete after their dependencies and local evidence
are complete.

### Fine-tuning a custom model

The repository includes a local, safe preparation pipeline under `training/`
for improving a compatible open-weight model with LoRA. It validates curated
chat/tool-call JSONL records, redacts common credential patterns, and scores a
deployed candidate against a separate hold-out set. It does not train from the
dashboard or send your task history to any provider.

Start with the reviewed sample records, then replace or expand them with your
own carefully reviewed examples:

```bash
npm run prepare:finetune
```

Upload the generated `training/build/agent-tool-calls.ready.jsonl` and a
separate validation set to NVIDIA NeMo Customizer, deploy the resulting model
through NVIDIA NIM, then set the private custom endpoint variables documented
in `.env.example`. Choose **Fine-tuned** in the dashboard for the deployed
model alone, or **Smart** to use it with the planning/review workflow. Evaluate
it before changing the normal agent route:

```bash
FINETUNE_MODEL=your-workspace/your-finetuned-model npm run evaluate:finetune
```

See [`training/README.md`](training/README.md) for the required data standard,
deployment handoff, and current NVIDIA documentation links. Never train on
credentials, raw conversation history, hidden reasoning, or unreviewed model
output.

The **Agent evaluations** card runs a separate, isolated baseline suite. It
checks the agent harness can build and test a small application, make a safe
existing-project change, and reject a protected-file write. Results report the
pass rate, steps, duration, and verification summary. This baseline never calls
the model API or spends model credits; it validates the agent workflow rather
than measuring a live model's coding ability.

Use **Run live model** only when you want to measure the configured local or
optional remote model route on the same scenarios. Live runs remain isolated
from your generated projects, but their results are real model measurements and
can fail because of local model quality, availability, task complexity, or an
incomplete implementation.

### Private Docker hosting

The included Docker setup is for a private, single-owner deployment. It runs
the service as an unprivileged Linux user, keeps credentials out of the image,
and requires a dashboard password when the UI is exposed beyond `127.0.0.1`.
It is not a public multi-user code-execution service.

1. Create `.env` from `.env.example`, then set a dashboard password:

   ```dotenv
   AGENT_UI_PASSWORD=use-a-long-unique-password-of-at-least-16-characters
   ```

2. Build and start a private container. A named volume preserves generated
   applications when the container is replaced:

   ```bash
   docker build -t my-coding-agent .
   docker run --name my-coding-agent --rm \
     --env-file .env \
     -p 3000:3000 \
     -v my-coding-agent-projects:/app/projects \
     my-coding-agent
   ```

3. Open [http://localhost:3000](http://localhost:3000). When the browser asks,
   use username `agent` and the dashboard password. Ollama must run beside the
   agent wherever the dashboard runs. For a cloud host, that means a paid
   GPU-backed model service; use the local setup for the free private option.

Do not mount your home directory, the Docker socket, or other sensitive host
paths into this container. The **Run project** preview is intentionally a
local-dashboard feature; when the agent is hosted, deploy generated projects
separately rather than exposing their development servers through the agent.
For a team deployment, add your provider's identity-aware proxy or access
control in front of the dashboard instead of sharing one password.

### Railway deployment

This repository can run on Railway, but the free Ollama setup is designed for
your Mac. A Railway deployment needs a separately hosted model service, which
is normally paid. Keep the agent local when you want free private AI.

### Command line

Start a continuous interactive session:

```bash
npm start
```

Type `exit`, `quit`, or press `Ctrl+C` to leave the session. The regular interface shows brief progress only. For tool-call details, use:

```bash
npm start -- --debug
```

Each task starts with a short `Working…` indicator and reports completed actions with a checkmark. Interactive and one-shot commands both use the same bounded local agent conversation, so a later command can follow up on earlier work. One-shot commands return a non-zero exit code if the agent cannot complete the task, which makes them suitable for scripts and CI checks.

You can also run one instruction and exit:

```bash
npm start -- "Create a simple Todo application"
```

## Example instructions

```text
Create a Todo application with add, complete, and delete actions.
Add dark mode.
Run tests and fix any errors.
Explain the structure of this project.
Create a portfolio website.
Select the todo app and add authentication.
```

For a new application, the model must first create an isolated project such as `projects/todo-app/`. On later instructions in the same session, that project remains active, so “Add dark mode” changes the Todo application rather than `my-agent/src`.

## Local learning and guarded self-improvement

The agent can retain short, reusable engineering lessons locally. Lessons are
stored in `projects/.agent-data/agent-lessons.json`, are bounded in size, redact
common secret assignments, and are supplied only as untrusted advisory context
when they match a later task. They are not model training, do not send data to a
third party, and must never contain task prompts, source excerpts, credentials,
or personal data.

For an explicit request such as **“Improve the agent's own source code”**, the
agent can inspect and change a narrow, non-security-critical subset of its own
repository. Every source change is read back and must pass the agent's own
`npm test` suite before it can report success. It can improve dashboard files,
tests, documentation, model routing, model health, project intelligence, and
task-history behavior.

The agent cannot self-edit the execution sandbox, terminal policy, tool
validation, workspace isolation, server access control, credentials, or other
safety-critical files. Those boundaries are deliberately manual-only. Normal
project tasks continue to operate only in `projects/<project-name>/`.

## Available tools

The model receives its tool list from the same registry that executes tools. It cannot successfully call unregistered tools; unknown names, malformed JSON, and invalid arguments are returned as structured errors for recovery.

| Tool | Purpose |
| --- | --- |
| `createProject` | Create and select an isolated project under `projects/`. |
| `listProjects`, `selectProject` | Discover or switch generated projects. |
| `listFiles`, `projectTree`, `readFile` | Inspect the active project. |
| `writeFile` | Create or replace a file in the active project. |
| `editFile` | Replace exact existing text safely; ambiguous or missing matches fail. |
| `projectReadiness` | Check the active project's implementation, manifest, test, and documentation readiness. |
| `test` | Run `npm test` in the active project. |
| `terminal` | Run a small allowlist of development commands. |
| `rememberLesson` | Save one short, non-secret local lesson for relevant future tasks. |
| `readAgentSource` | Read permitted agent source during an explicit self-improvement task. |
| `writeAgentSource`, `editAgentSource` | Change permitted non-security-critical agent source, then read it back. |
| `testAgentSource` | Run the agent's own `npm test` after a self-improvement change. |

`terminal` accepts only:

```text
pwd
ls
npm install
npm test
npm run build
node --version
node --check <relative-file>
```

There is no terminal working-directory argument, shell operators, redirection, or arbitrary command execution. `npm install` runs with package lifecycle scripts disabled.

## Workspace isolation and security

- File tools operate only inside the selected `projects/<project-name>` directory.
- Agent source files are not an active project workspace, so generated applications cannot accidentally overwrite `src/`.
- All file paths must be relative. Absolute paths, `~`, `../` traversal, protected `.env` files, `.git`, `node_modules`, and symlinks that resolve outside the project are rejected.
- Tool failures use `{ ok, tool, result, error }`, allowing the model to inspect and recover without crashing the session.
- Each agent run has a 30-step limit. If it reaches the limit, it reports what it completed rather than claiming success.
- Agent-source tools are unavailable unless the user explicitly asks for self-improvement, and they cannot edit the safety-critical boundaries listed above.

The terminal allowlist removes shell injection and caller-controlled directories. By default, npm scripts and build tools still execute project code on the host, so use generated projects and dependencies you trust. Set `AGENT_EXECUTION_MODE=docker` to run test/build/node checks inside the documented network-disabled Docker boundary; it is the recommended setting when generated code is less trusted.

Generated-project commands run with a minimal temporary environment, so they do
not inherit the agent's provider, GitHub, or dashboard secrets. The production
Docker image also makes the agent source read-only to the unprivileged runtime;
use a development checkout for the explicit self-improvement workflow. These
measures reduce credential and source-tampering risk. Docker mode adds a
separate sandboxed container for checks, but a dedicated microVM remains the
stronger choice for hostile or multi-tenant project code.

## Verification behavior

After every `writeFile` or `editFile`, the agent must immediately read the same file and compare its actual contents with the expected result. A final success response is blocked until the latest verified modification has a passing `npm test` run. The same gate applies to `writeAgentSource` and `editAgentSource`, except those changes require `readAgentSource` and `testAgentSource`.

The system prompt also tells the model to inspect first, create a usable multi-file application rather than a placeholder, run `npm run build` when the project's `package.json` provides a build script, inspect errors, repair them, and retest.

## Test the agent

```bash
npm test
```

The suite covers file operations, exact editing, project isolation, protected paths, traversal and symlink escapes, terminal safety, tool-call validation, malformed model output, unknown tools, verification gates, iteration limits, and a scripted end-to-end Todo application session:

1. Create a Todo project.
2. Write and read back its files.
3. Build and test it.
4. Add dark mode, then build and test it again.
5. Explain the project structure.
6. Reject a request to read `../../.ssh/config`.

GitHub Actions runs this same locked Node 22 test suite for pull requests and
every push to `main`. Railway can use the passing `main` build as its
deployment gate.

## Limitations

- Local use depends on Ollama and the selected model's ability to select tools correctly. Hosted use needs a configured remote provider, NVIDIA route, or secured remote Ollama endpoint.
- It supports one active generated project per interactive session; use `selectProject` to switch.
- Only the listed terminal commands are available. Applications with other build systems may need support added deliberately.
- Docker execution mode is a strong project-code boundary, but it is not a replacement for a dedicated microVM or a multi-tenant code-execution service.
