import { createTerminalTool } from "./terminal.js";

export function createTestTool(workspaceManager) {
    const terminal = createTerminalTool(workspaceManager);

    return function runTests() {
        return terminal({ command: "npm test" });
    };
}
