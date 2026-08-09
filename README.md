# My Coding Agent

My Coding Agent is a small, safety-conscious local coding agent powered by NVIDIA Nemotron. It accepts natural-language coding instructions, chooses from a validated set of tools, and works only in a generated application workspace.

The agent source and generated applications are deliberately separate:

```text
my-agent/
├── src/                 # the coding agent itself
├── test/                # agent tests
└── projects/            # applications created by the agent
    ├── todo-app/
    └── portfolio/
```

## Install and configure

Use Node.js 20 or later.

```bash
npm install
cp .env.example .env
```

Set your NVIDIA API key in `.env`:

```dotenv
NVIDIA_API_KEY=your_nvidia_api_key_here
```

By default, the agent routes each task across three open-weight models. Auto
starts routine fixes and app/website builds with DeepSeek V4 Flash, uses
Nemotron 3 Ultra for substantial full-stack or multi-file work, and reserves
GLM-5.2 for architecture, security, migrations, and long-horizon tasks. If one
provider is temporarily unavailable, it automatically moves to the next
suitable model.

To start every task with one model, add one of these optional settings:

```dotenv
NVIDIA_MODEL_MODE=flash  # or: ultra, glm
```

To use a model not in the three-model route, set a custom model instead:

```dotenv
NVIDIA_MODEL=provider/model-id
```

Use either `NVIDIA_MODEL_MODE` or `NVIDIA_MODEL`; leave both out to use Auto.

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

Then open [http://127.0.0.1:3333](http://127.0.0.1:3333). It uses the same local project workspace and NVIDIA configuration as the command-line agent, shows live tool activity, and keeps the selected project active between tasks. Auto starts routine work on DeepSeek Flash and moves to Nemotron Ultra or GLM-5.2 only for heavier requests; you can still select one lane explicitly. The UI listens only on your computer; use `AGENT_UI_PORT` to choose another local port. Use **Cancel task** to stop a model request or command in progress; completed file changes are intentionally kept.

The Workspace panel includes **Run project** for the active app. It starts a local preview on an unused port and provides an **Open** button. For safety, previews support projects whose `package.json` start script uses the form `node server.js`; the preview does not receive the agent's API key or other environment variables.

The dashboard also checks whether its configured model routes are currently
available. A status-check problem does not expose your key or prevent a task
from using its normal retry and fallback behavior.

### Private Docker hosting

The included Docker setup is for a private, single-owner deployment. It runs
the service as an unprivileged Linux user, keeps credentials out of the image,
and requires a dashboard password when the UI is exposed beyond `127.0.0.1`.
It is not a public multi-user code-execution service.

1. Create `.env` from `.env.example`, then set both secrets:

   ```dotenv
   NVIDIA_API_KEY=your_nvidia_api_key_here
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
   use username `agent` and the dashboard password. For a cloud host, store
   `NVIDIA_API_KEY` and `AGENT_UI_PASSWORD` as platform secrets, attach
   persistent storage at `/app/projects`, expose port `3000`, and place the
   service behind HTTPS.

Do not mount your home directory, the Docker socket, or other sensitive host
paths into this container. The **Run project** preview is intentionally a
local-dashboard feature; when the agent is hosted, deploy generated projects
separately rather than exposing their development servers through the agent.
For a team deployment, add your provider's identity-aware proxy or access
control in front of the dashboard instead of sharing one password.

### Command line

Start a continuous interactive session:

```bash
npm start
```

Type `exit`, `quit`, or press `Ctrl+C` to leave the session. The regular interface shows brief progress only. For tool-call details, use:

```bash
npm start -- --debug
```

Each task starts with a short `Working…` indicator and reports completed actions with a checkmark. One-shot commands return a non-zero exit code if the agent cannot complete the task, which makes them suitable for scripts and CI checks.

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

## Available tools

The model receives its tool list from the same registry that executes tools. It cannot successfully call unregistered tools; unknown names, malformed JSON, and invalid arguments are returned as structured errors for recovery.

| Tool | Purpose |
| --- | --- |
| `createProject` | Create and select an isolated project under `projects/`. |
| `listProjects`, `selectProject` | Discover or switch generated projects. |
| `listFiles`, `projectTree`, `readFile` | Inspect the active project. |
| `writeFile` | Create or replace a file in the active project. |
| `editFile` | Replace exact existing text safely; ambiguous or missing matches fail. |
| `test` | Run `npm test` in the active project. |
| `terminal` | Run a small allowlist of development commands. |

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

The terminal allowlist removes shell injection and caller-controlled directories, but this is not a kernel-level security sandbox: npm scripts and build tools execute project code. Use generated projects and dependencies you trust; do not treat this as a safe runner for hostile code.

## Verification behavior

After every `writeFile` or `editFile`, the agent must immediately read the same file and compare its actual contents with the expected result. A final success response is blocked until the latest verified modification has a passing `npm test` run.

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

## Limitations

- The agent depends on a configured NVIDIA API key and the model's ability to select tools correctly.
- It supports one active generated project per interactive session; use `selectProject` to switch.
- Only the listed terminal commands are available. Applications with other build systems may need support added deliberately.
- It does not provide browser automation, visual checks, Git operations, package publishing, deployment, or an operating-system-level sandbox.
