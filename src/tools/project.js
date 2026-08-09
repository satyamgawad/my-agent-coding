import fs from "node:fs";
import path from "node:path";
import { createSandbox } from "./sandbox.js";

const MAX_TREE_ENTRIES = 500;

export function createProjectTreeTool(workspaceManager) {
    const sandbox = createSandbox(() => workspaceManager.getActiveWorkspace());

    function buildTree(directory, state, prefix = "") {
        const entries = fs
            .readdirSync(directory, { withFileTypes: true })
            .filter((entry) => !entry.isSymbolicLink())
            .filter(
                (entry) => !sandbox.isProtectedPath(path.join(directory, entry.name))
            )
            .sort((left, right) => left.name.localeCompare(right.name));
        let tree = "";

        for (const entry of entries) {
            if (state.entries >= MAX_TREE_ENTRIES) {
                state.truncated = true;
                break;
            }

            state.entries += 1;
            const fullPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                tree += `${prefix}📁 ${entry.name}/\n${buildTree(
                    fullPath,
                    state,
                    `${prefix}  `
                )}`;
            } else {
                tree += `${prefix}📄 ${entry.name}\n`;
            }

            if (state.truncated) {
                break;
            }
        }

        return tree;
    }

    return function projectTree({ directory }) {
        const state = { entries: 0, truncated: false };
        const tree = buildTree(sandbox.safePath(directory), state);
        return state.truncated
            ? `${tree}… tree truncated after ${MAX_TREE_ENTRIES} entries; inspect a narrower directory.\n`
            : tree;
    };
}
