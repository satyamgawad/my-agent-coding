import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createSandbox } from "./sandbox.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;

function terminalError(message, code = "UNSAFE_COMMAND") {
    const error = new Error(message);
    error.code = code;
    return error;
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

    if (tokens.join(" ") === "node --version") {
        return { file: "node", arguments: ["--version"] };
    }

    if (tokens.length === 3 && tokens[0] === "node" && tokens[1] === "--check") {
        const filePath = tokens[2];

        if (filePath.startsWith("-") || path.isAbsolute(filePath)) {
            throw terminalError("terminal rejected an unsafe node file path.");
        }

        sandbox.safePath(filePath);
        return { file: "node", arguments: ["--check", filePath] };
    }

    throw terminalError(
        'terminal supports only: "pwd", "ls", "npm install", "npm test", "npm run build", "node --version", and "node --check <relative-file>".'
    );
}

export function createTerminalTool(workspaceManager) {
    const sandbox = createSandbox(() => workspaceManager.getActiveWorkspace());

    return async function runTerminal({ command }) {
        const selectedCommand = commandSpec(command, sandbox);

        try {
            const { stdout, stderr } = await execFileAsync(
                selectedCommand.file,
                selectedCommand.arguments,
                {
                    cwd: sandbox.workspace(),
                    maxBuffer: 1024 * 1024,
                    timeout: COMMAND_TIMEOUT_MS,
                    shell: false,
                }
            );

            return { stdout, stderr, exitCode: 0 };
        } catch (error) {
            return {
                stdout: error.stdout || "",
                stderr: error.stderr || error.message,
                exitCode: Number.isInteger(error.code) ? error.code : 1,
            };
        }
    };
}
