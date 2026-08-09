import { createTerminalTool } from "./terminal.js";

export function createTestTool(workspaceManager) {
    const terminal = createTerminalTool(workspaceManager);

    return function runTests(_argumentsValue, options) {
        return terminal({ command: "npm test" }, options);
    };
}
