import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createSandbox } from "./sandbox.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_TERMINAL_OUTPUT_CHARS = 16 * 1024;
const EXTRA_NPM_SCRIPTS = new Set([
    "lint",
    "typecheck",
    "check",
    "format:check",
    "test:unit",
    "test:e2e",
]);
export const EXECUTION_MODES = new Set(["host", "docker"]);
export const DEFAULT_EXECUTION_MODE = "host";
const DEFAULT_DOCKER_IMAGE = "node:22-alpine";

export function resolveExecutionMode(value = process.env.AGENT_EXECUTION_MODE) {
    const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
    return EXECUTION_MODES.has(mode) ? mode : DEFAULT_EXECUTION_MODE;
}

function terminalError(message, code = "UNSAFE_COMMAND") {
    const error = new Error(message);
    error.code = code;
    return error;
}

function boundedOutput(value) {
    const output = typeof value === "string" ? value : String(value || "");

    if (output.length <= MAX_TERMINAL_OUTPUT_CHARS) {
        return output;
    }

    return `… output truncated; showing the last ${MAX_TERMINAL_OUTPUT_CHARS} characters.\n${output.slice(-MAX_TERMINAL_OUTPUT_CHARS)}`;
}

function requirePackageJson(command, sandbox) {
    const packageJson = path.join(sandbox.workspace(), "package.json");

    if (!fs.existsSync(packageJson)) {
        throw terminalError(
            `Cannot run "${command}" because the active project has no package.json. Create package.json with writeFile, verify it with readFile, then retry.`,
            "PACKAGE_JSON_REQUIRED"
        );
    }
}

function commandSpec(command, sandbox) {
    const tokens = command.trim().split(/\s+/);

    if (tokens.length === 1 && tokens[0] === "pwd") {
        return { file: "pwd", arguments: [] };
    }

    if (tokens.length === 1 && tokens[0] === "ls") {
        return { file: "ls", arguments: [] };
    }

    if (tokens.join(" ") === "npm install") {
        return { file: "npm", arguments: ["install", "--ignore-scripts"] };
    }

    if (tokens.join(" ") === "npm test") {
        requirePackageJson("npm test", sandbox);
        return { file: "npm", arguments: ["test"] };
    }

    if (tokens.join(" ") === "npm run build") {
        requirePackageJson("npm run build", sandbox);
        return { file: "npm", arguments: ["run", "build"] };
    }

    if (tokens.length === 3 && tokens[0] === "npm" && tokens[1] === "run" && EXTRA_NPM_SCRIPTS.has(tokens[2])) {
        requirePackageJson(`npm run ${tokens[2]}`, sandbox);
        return { file: "npm", arguments: ["run", tokens[2]] };
    }

    if (tokens.join(" ") === "node --version") {
        return { file: "node", arguments: ["--version"] };
    }

    if (tokens.length === 3 && tokens[0] === "node" && ["--check", "--test"].includes(tokens[1])) {
        const filePath = tokens[2];

        if (filePath.startsWith("-") || path.isAbsolute(filePath)) {
            throw terminalError("terminal rejected an unsafe node file path.");
        }

        sandbox.safePath(filePath);
        return { file: "node", arguments: [tokens[1], filePath] };
    }

    throw terminalError(
        'terminal supports project-safe checks only: "pwd", "ls", "npm install", "npm test", "npm run build", npm run lint/typecheck/check/format:check/test:unit/test:e2e, "node --version", "node --check <relative-file>", and "node --test <relative-file>".'
    );
}

function commandEnvironment() {
    // npm scripts execute generated project code. Do not pass the agent
    // process environment into that code: it can contain model, publishing,
    // and dashboard credentials. A private temporary npm home also prevents
    // project commands from reading the operator's npm configuration.
    const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-command-"));
    const npmConfig = path.join(runtimeDirectory, "npmrc");
    const globalNpmConfig = path.join(runtimeDirectory, "global-npmrc");
    fs.writeFileSync(npmConfig, "", { mode: 0o600 });
    fs.writeFileSync(globalNpmConfig, "", { mode: 0o600 });

    return {
        env: {
            PATH: process.env.PATH || "",
            HOME: runtimeDirectory,
            USERPROFILE: runtimeDirectory,
            npm_config_userconfig: npmConfig,
            npm_config_globalconfig: globalNpmConfig,
            npm_config_cache: path.join(runtimeDirectory, "npm-cache"),
            npm_config_update_notifier: "false",
        },
        cleanup() {
            fs.rmSync(runtimeDirectory, { recursive: true, force: true });
        },
    };
}

function runsProjectCode(command) {
    if (command.file === "node") return true;
    if (command.file !== "npm") return false;

    return command.arguments[0] !== "install";
}

export function dockerCommandSpec(command, workspace, environment = process.env) {
    const image = typeof environment.AGENT_SANDBOX_IMAGE === "string" && environment.AGENT_SANDBOX_IMAGE.trim()
        ? environment.AGENT_SANDBOX_IMAGE.trim()
        : DEFAULT_DOCKER_IMAGE;

    return {
        file: "docker",
        arguments: [
            "run",
            "--rm",
            "--network", "none",
            "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--pids-limit", "128",
            "--memory", "1g",
            "--cpus", "1.5",
            "--mount", `type=bind,src=${workspace},dst=/workspace,rw`,
            "--workdir", "/workspace",
            "--env", "HOME=/tmp",
            "--env", "NODE_ENV=test",
            image,
            command.file,
            ...command.arguments,
        ],
    };
}

export function createTerminalTool(workspaceManager, {
    executionMode = resolveExecutionMode(),
    runCommand = execFileAsync,
} = {}) {
    const sandbox = createSandbox(() => workspaceManager.getActiveWorkspace());

    return async function runTerminal({ command }, { signal } = {}) {
        const selectedCommand = commandSpec(command, sandbox);
        const executableCommand = executionMode === "docker" && runsProjectCode(selectedCommand)
            ? dockerCommandSpec(selectedCommand, sandbox.workspace())
            : selectedCommand;
        const environment = commandEnvironment();

        try {
            const { stdout, stderr } = await runCommand(
                executableCommand.file,
                executableCommand.arguments,
                {
                    cwd: sandbox.workspace(),
                    maxBuffer: 1024 * 1024,
                    timeout: COMMAND_TIMEOUT_MS,
                    shell: false,
                    signal,
                    env: environment.env,
                }
            );

            return {
                stdout: boundedOutput(stdout),
                stderr: boundedOutput(stderr),
                exitCode: 0,
            };
        } catch (error) {
            return {
                stdout: boundedOutput(error.stdout || ""),
                stderr: boundedOutput(error.stderr || error.message),
                exitCode: Number.isInteger(error.code) ? error.code : 1,
            };
        } finally {
            environment.cleanup();
        }
    };
}
