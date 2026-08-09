import { spawn } from "node:child_process";
import { createServer, get } from "node:http";
import fs from "node:fs";
import path from "node:path";

const START_TIMEOUT_MS = 6_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_LENGTH = 4_000;

function runnerError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessRunning(record) {
    return Boolean(record?.process && record.exitCode === null && !record.error);
}

function isRunning(record) {
    return isProcessRunning(record) && !record.stopRequested;
}

function appendOutput(record, chunk) {
    record.output = `${record.output}${chunk.toString()}`.slice(-MAX_OUTPUT_LENGTH);
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function serverResponds(port) {
    return new Promise((resolve) => {
        const request = get({ host: "127.0.0.1", port, path: "/" }, (response) => {
            response.resume();
            resolve(true);
        });

        request.setTimeout(250, () => request.destroy());
        request.once("error", () => resolve(false));
    });
}

async function waitForProject(record) {
    const deadline = Date.now() + START_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (!isRunning(record)) {
            return false;
        }

        if (await serverResponds(record.port)) {
            return true;
        }

        await delay(100);
    }

    return false;
}

function projectEnvironment(port) {
    return {
        PATH: process.env.PATH || "",
        PORT: String(port),
        NODE_ENV: "production",
    };
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function startCommand(manifest, workspace) {
    const script = manifest?.scripts?.start;

    if (typeof script !== "string") {
        throw runnerError(
            "This project needs a start script in package.json before it can run.",
            "PROJECT_START_UNAVAILABLE"
        );
    }

    const [command, filePath, ...argumentsValue] = script.trim().split(/\s+/);

    if (command !== "node" || !filePath || argumentsValue.length > 0) {
        throw runnerError(
            "For safe previews, the start script must use the form: node server.js.",
            "PROJECT_START_UNSUPPORTED"
        );
    }

    const workspacePath = fs.realpathSync(workspace);
    const requestedPath = path.resolve(workspacePath, filePath);

    if (path.isAbsolute(filePath) || !isInside(workspacePath, requestedPath) || !fs.existsSync(requestedPath)) {
        throw runnerError(
            "The start script must point to an existing file inside the active project.",
            "PROJECT_START_UNSUPPORTED"
        );
    }

    const resolvedPath = fs.realpathSync(requestedPath);

    if (!isInside(workspacePath, resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        throw runnerError(
            "The start script must point to a regular file inside the active project.",
            "PROJECT_START_UNSUPPORTED"
        );
    }

    return { file: process.execPath, arguments: [resolvedPath] };
}

function displayOutput(record) {
    const output = record.output.trim();
    return output ? ` ${output}` : "";
}

function sendSignal(child, signal) {
    try {
        return child.kill(signal);
    } catch {
        return false;
    }
}

export default class ProjectRunner {
    constructor(workspaceManager) {
        this.workspaceManager = workspaceManager;
        this.active = null;
    }

    status() {
        if (!this.active) {
            return { state: "idle", project: null, url: null };
        }

        return {
            state: isRunning(this.active) ? "running" : "stopped",
            project: this.active.project,
            url: isRunning(this.active) ? `http://127.0.0.1:${this.active.port}` : null,
            output: this.active.output.trim() || null,
        };
    }

    async run() {
        const context = this.workspaceManager.getContext();

        if (!context.project) {
            throw runnerError("Select a project before running it.", "NO_ACTIVE_PROJECT");
        }

        if (isRunning(this.active) && this.active.project === context.project) {
            return this.status();
        }

        if (isRunning(this.active)) {
            await this.stop();

            if (isProcessRunning(this.active)) {
                throw runnerError(
                    "The previous project preview is still shutting down. Try again in a moment.",
                    "PROJECT_STOPPING"
                );
            }
        }

        const workspace = this.workspaceManager.getActiveWorkspace();
        const packagePath = path.join(workspace, "package.json");
        let manifest;

        try {
            manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        } catch {
            throw runnerError(
                "This project needs a valid package.json with a start script before it can run.",
                "PROJECT_START_UNAVAILABLE"
            );
        }

        const command = startCommand(manifest, workspace);

        const port = await getFreePort();
        const child = spawn(command.file, command.arguments, {
            cwd: workspace,
            env: projectEnvironment(port),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const record = {
            process: child,
            project: context.project,
            port,
            output: "",
            exitCode: null,
            error: null,
            stopRequested: false,
        };

        child.stdout.on("data", (chunk) => appendOutput(record, chunk));
        child.stderr.on("data", (chunk) => appendOutput(record, chunk));
        child.once("error", (error) => {
            record.error = error;
            appendOutput(record, error.message);
        });
        child.once("exit", (code) => {
            record.exitCode = code;
        });
        this.active = record;

        if (await waitForProject(record)) {
            return this.status();
        }

        await this.stop();
        throw runnerError(
            `The project did not start a local website.${displayOutput(record)}`,
            "PROJECT_START_FAILED"
        );
    }

    async stop() {
        if (!isProcessRunning(this.active) || this.active.stopRequested) {
            return this.status();
        }

        const record = this.active;
        record.stopRequested = true;
        const stopped = new Promise((resolve) => {
            record.process.once("exit", resolve);
        });

        sendSignal(record.process, "SIGTERM");

        await Promise.race([stopped, delay(STOP_TIMEOUT_MS)]);

        if (isProcessRunning(record)) {
            sendSignal(record.process, "SIGKILL");

            await Promise.race([stopped, delay(STOP_TIMEOUT_MS)]);
        }

        return this.status();
    }
}
