import fs from "node:fs";
import path from "node:path";
import { createSandbox } from "./sandbox.js";

const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;

function fileError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function visibleEntries(directory, sandbox) {
    const entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !entry.isSymbolicLink())
        .filter(
            (entry) => !sandbox.isProtectedPath(path.join(directory, entry.name))
        )
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

    if (entries.length > MAX_DIRECTORY_ENTRIES) {
        throw fileError(
            `This directory has more than ${MAX_DIRECTORY_ENTRIES} visible entries. Inspect a narrower subdirectory instead.`,
            "DIRECTORY_TOO_LARGE"
        );
    }

    return entries;
}

function requireManageableTextFile(fullPath) {
    const details = fs.statSync(fullPath);

    if (!details.isFile()) {
        throw fileError("The requested path must be a regular file.", "INVALID_FILE_TYPE");
    }

    if (details.size > MAX_TEXT_FILE_BYTES) {
        throw fileError(
            `This file is larger than ${MAX_TEXT_FILE_BYTES} bytes. Inspect or edit a smaller source file instead.`,
            "FILE_TOO_LARGE"
        );
    }
}

export function createFileTools(workspaceManager) {
    const sandbox = createSandbox(() => workspaceManager.getActiveWorkspace());

    return {
        listFiles({ directory = "." } = {}) {
            return visibleEntries(sandbox.safePath(directory), sandbox);
        },

        readFile({ filePath } = {}) {
            if (!filePath) {
                throw fileError("readFile requires a filePath.", "INVALID_ARGUMENT");
            }

            const fullPath = sandbox.safePath(filePath);
            requireManageableTextFile(fullPath);
            return fs.readFileSync(fullPath, "utf8");
        },

        writeFile({ filePath, content } = {}) {
            if (!filePath) {
                throw fileError("writeFile requires a filePath.", "INVALID_ARGUMENT");
            }

            if (content === undefined) {
                throw fileError("writeFile requires content.", "INVALID_ARGUMENT");
            }

            const fullPath = sandbox.safePath(filePath);
            const created = !fs.existsSync(fullPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, "utf8");

            return {
                filePath,
                content,
                bytes: Buffer.byteLength(content, "utf8"),
                created,
            };
        },

        editFile({ filePath, oldText, newText, replaceAll = false } = {}) {
            if (!filePath) {
                throw fileError("editFile requires a filePath.", "INVALID_ARGUMENT");
            }

            if (oldText === undefined || oldText === "") {
                throw fileError("editFile requires a non-empty oldText.", "INVALID_ARGUMENT");
            }

            if (newText === undefined) {
                throw fileError("editFile requires newText.", "INVALID_ARGUMENT");
            }

            const fullPath = sandbox.safePath(filePath);
            requireManageableTextFile(fullPath);
            const content = fs.readFileSync(fullPath, "utf8");
            const occurrences = content.split(oldText).length - 1;

            if (occurrences === 0) {
                throw fileError("editFile: oldText was not found.", "TEXT_NOT_FOUND");
            }

            if (occurrences > 1 && !replaceAll) {
                throw fileError(
                    `editFile: oldText appears ${occurrences} times. Refusing ambiguous edit.`,
                    "AMBIGUOUS_EDIT"
                );
            }

            const replacements = replaceAll ? occurrences : 1;
            const updatedContent = replaceAll
                ? content.split(oldText).join(newText)
                : content.replace(oldText, newText);
            fs.writeFileSync(fullPath, updatedContent, "utf8");

            return {
                filePath,
                content: updatedContent,
                bytes: Buffer.byteLength(updatedContent, "utf8"),
                created: false,
                replacements,
            };
        },
    };
}
