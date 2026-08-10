import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_TERMINAL_OUTPUT_CHARS = 16 * 1024;
const SOURCE_TEST_TIMEOUT_MS = 60_000;
const READABLE_ROOTS = new Set(["src", "public", "test", ".github"]);
const WRITABLE_ROOTS = new Set(["public", "test"]);
const WRITABLE_SOURCE_FILES = new Set([
    "README.md",
    "src/model-health.js",
    "src/model-router.js",
    "src/project-intelligence.js",
    "src/task-history.js",
]);

function sourceError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function boundedOutput(value) {
    const output = typeof value === "string" ? value : String(value || "");
    return output.length <= MAX_TERMINAL_OUTPUT_CHARS
        ? output
        : `… output truncated; showing the last ${MAX_TERMINAL_OUTPUT_CHARS} characters.\n${output.slice(-MAX_TERMINAL_OUTPUT_CHARS)}`;
}

function resolveExistingPath(fullPath) {
    let existingPath = fullPath;

    while (!fs.existsSync(existingPath)) {
        const parentPath = path.dirname(existingPath);
        if (parentPath === existingPath) break;
        existingPath = parentPath;
    }

    const resolvedExistingPath = fs.realpathSync(existingPath);
    return path.resolve(resolvedExistingPath, path.relative(existingPath, fullPath));
}

function relativeSourcePath(agentRoot, filePath) {
    return path.relative(agentRoot, filePath).split(path.sep).join("/");
}

function readAllowed(relativePath) {
    const [root] = relativePath.split("/");
    return READABLE_ROOTS.has(root) || ["README.md", "package.json", "Dockerfile"].includes(relativePath);
}

function writeAllowed(relativePath) {
    const [root] = relativePath.split("/");
    return WRITABLE_ROOTS.has(root) || WRITABLE_SOURCE_FILES.has(relativePath);
}

function requireTextFile(fullPath) {
    let details;

    try {
        details = fs.statSync(fullPath);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw sourceError("The requested agent source file does not exist.", "SOURCE_FILE_NOT_FOUND");
        }
        throw error;
    }

    if (!details.isFile()) {
        throw sourceError("The requested agent source path must be a regular file.", "INVALID_SOURCE_FILE_TYPE");
    }

    if (details.size > MAX_TEXT_FILE_BYTES) {
        throw sourceError("The requested agent source file is too large to edit safely.", "SOURCE_FILE_TOO_LARGE");
    }
}

function resolveSourcePath(agentRoot, userPath, { write = false } = {}) {
    const root = fs.realpathSync(agentRoot);

    if (typeof userPath !== "string" || !userPath.trim()) {
        throw sourceError("A non-empty agent source path is required.", "INVALID_SOURCE_PATH");
    }

    if (path.isAbsolute(userPath) || path.win32.isAbsolute(userPath) || userPath.startsWith("~") || userPath.includes("\0")) {
        throw sourceError("Agent source paths must be safe relative paths.", "INVALID_SOURCE_PATH");
    }

    const fullPath = path.resolve(root, userPath);
    const relativePath = relativeSourcePath(root, fullPath);

    if (!isInside(root, fullPath) || !relativePath || relativePath.startsWith("..")) {
        throw sourceError("Agent source access is outside the repository.", "SOURCE_OUTSIDE_ROOT");
    }

    if (relativePath.split("/").some((segment) => segment === ".git" || segment === "node_modules" || segment === ".env" || segment.startsWith(".env."))) {
        throw sourceError("Agent source access to protected files is denied.", "SOURCE_PROTECTED_PATH");
    }

    if (!(write ? writeAllowed(relativePath) : readAllowed(relativePath))) {
        throw sourceError(
            write
                ? "That source file is safety-critical and can only be changed manually."
                : "That path is outside the readable agent source set.",
            write ? "SOURCE_WRITE_RESTRICTED" : "SOURCE_READ_RESTRICTED"
        );
    }

    if (!isInside(root, resolveExistingPath(fullPath))) {
        throw sourceError("Agent source access through an escaping symlink is denied.", "SOURCE_SYMLINK_ESCAPE");
    }

    return { fullPath, relativePath };
}

export function createAgentSourceTools({ agentRoot }) {
    if (typeof agentRoot !== "string" || !agentRoot) {
        throw new TypeError("Agent source tools need an agent root.");
    }

    return {
        readAgentSource({ filePath } = {}) {
            const { fullPath } = resolveSourcePath(agentRoot, filePath);
            requireTextFile(fullPath);
            return fs.readFileSync(fullPath, "utf8");
        },

        writeAgentSource({ filePath, content } = {}) {
            if (typeof content !== "string") {
                throw sourceError("writeAgentSource requires text content.", "INVALID_SOURCE_CONTENT");
            }

            const { fullPath, relativePath } = resolveSourcePath(agentRoot, filePath, { write: true });
            const created = !fs.existsSync(fullPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, "utf8");
            return { filePath: relativePath, content, bytes: Buffer.byteLength(content, "utf8"), created };
        },

        editAgentSource({ filePath, oldText, newText, replaceAll = false } = {}) {
            if (typeof oldText !== "string" || !oldText) {
                throw sourceError("editAgentSource requires non-empty oldText.", "INVALID_SOURCE_EDIT");
            }
            if (typeof newText !== "string") {
                throw sourceError("editAgentSource requires text newText.", "INVALID_SOURCE_EDIT");
            }

            const { fullPath, relativePath } = resolveSourcePath(agentRoot, filePath, { write: true });
            requireTextFile(fullPath);
            const content = fs.readFileSync(fullPath, "utf8");
            const occurrences = content.split(oldText).length - 1;

            if (occurrences === 0) {
                throw sourceError("editAgentSource: oldText was not found.", "SOURCE_TEXT_NOT_FOUND");
            }
            if (occurrences > 1 && !replaceAll) {
                throw sourceError("editAgentSource: oldText is ambiguous.", "SOURCE_AMBIGUOUS_EDIT");
            }

            const updatedContent = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
            fs.writeFileSync(fullPath, updatedContent, "utf8");
            return {
                filePath: relativePath,
                content: updatedContent,
                bytes: Buffer.byteLength(updatedContent, "utf8"),
                created: false,
                replacements: replaceAll ? occurrences : 1,
            };
        },

        async testAgentSource(_arguments = {}, { signal } = {}) {
            try {
                const { stdout, stderr } = await execFileAsync("npm", ["test"], {
                    cwd: fs.realpathSync(agentRoot),
                    env: { PATH: process.env.PATH || "", NODE_ENV: "test" },
                    maxBuffer: 1024 * 1024,
                    timeout: SOURCE_TEST_TIMEOUT_MS,
                    shell: false,
                    signal,
                });
                return { stdout: boundedOutput(stdout), stderr: boundedOutput(stderr), exitCode: 0 };
            } catch (error) {
                return {
                    stdout: boundedOutput(error.stdout || ""),
                    stderr: boundedOutput(error.stderr || error.message),
                    exitCode: Number.isInteger(error.code) ? error.code : 1,
                };
            }
        },
    };
}
