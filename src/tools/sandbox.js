import fs from "node:fs";
import path from "node:path";

const PROTECTED_PATH_SEGMENTS = new Set([".git", "node_modules"]);

function isInsideWorkspace(workspace, candidate) {
    return candidate === workspace || candidate.startsWith(`${workspace}${path.sep}`);
}

function sandboxError(message) {
    const error = new Error(message);
    error.code = "SANDBOX_VIOLATION";
    return error;
}

function resolveExistingPath(fullPath) {
    let existingPath = fullPath;

    while (!fs.existsSync(existingPath)) {
        const parentPath = path.dirname(existingPath);

        if (parentPath === existingPath) {
            break;
        }

        existingPath = parentPath;
    }

    const resolvedExistingPath = fs.realpathSync(existingPath);
    const remainingPath = path.relative(existingPath, fullPath);
    return path.resolve(resolvedExistingPath, remainingPath);
}

function normalizedWorkspace(workspace) {
    if (typeof workspace !== "string" || !workspace) {
        throw sandboxError("No active workspace is available.");
    }

    return fs.realpathSync(workspace);
}

export function isProtectedPath(fullPath, workspace = process.cwd()) {
    const root = normalizedWorkspace(workspace);
    const relativePath = path.relative(root, fullPath);

    if (!relativePath || relativePath.startsWith(`..${path.sep}`)) {
        return false;
    }

    return relativePath.split(path.sep).some((segment) => {
        return (
            PROTECTED_PATH_SEGMENTS.has(segment) ||
            segment === ".env" ||
            segment.startsWith(".env.")
        );
    });
}

export function safePath(userPath, workspace = process.cwd()) {
    const root = normalizedWorkspace(workspace);

    if (typeof userPath !== "string" || !userPath.trim()) {
        throw sandboxError("A non-empty workspace path is required.");
    }

    if (
        path.isAbsolute(userPath) ||
        path.win32.isAbsolute(userPath) ||
        userPath.startsWith("~")
    ) {
        throw sandboxError("Access denied: path must be relative to the workspace.");
    }

    if (userPath.includes("\0")) {
        throw sandboxError("Access denied: path contains an invalid character.");
    }

    const fullPath = path.resolve(root, userPath);

    if (!isInsideWorkspace(root, fullPath)) {
        throw sandboxError("Access denied: path is outside the workspace.");
    }

    if (isProtectedPath(fullPath, root)) {
        throw sandboxError("Access denied: path is protected.");
    }

    if (!isInsideWorkspace(root, resolveExistingPath(fullPath))) {
        throw sandboxError(
            "Access denied: path resolves outside the workspace through a symlink."
        );
    }

    return fullPath;
}

export function createSandbox(getWorkspace) {
    const workspace = () => getWorkspace();

    return {
        safePath(userPath) {
            return safePath(userPath, workspace());
        },
        isProtectedPath(fullPath) {
            return isProtectedPath(fullPath, workspace());
        },
        workspace,
    };
}
