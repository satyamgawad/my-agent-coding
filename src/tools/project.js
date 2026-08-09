import fs from "node:fs";
import path from "node:path";
import { createSandbox } from "./sandbox.js";

export function createProjectTreeTool(workspaceManager) {
    const sandbox = createSandbox(() => workspaceManager.getActiveWorkspace());

    function buildTree(directory, prefix = "") {
        return fs
            .readdirSync(directory, { withFileTypes: true })
            .filter((entry) => !entry.isSymbolicLink())
            .filter(
                (entry) => !sandbox.isProtectedPath(path.join(directory, entry.name))
            )
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => {
                const fullPath = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    return `${prefix}📁 ${entry.name}/\n${buildTree(
                        fullPath,
                        `${prefix}  `
                    )}`;
                }

                return `${prefix}📄 ${entry.name}\n`;
            })
            .join("");
    }

    return function projectTree({ directory }) {
        return buildTree(sandbox.safePath(directory));
    };
}
