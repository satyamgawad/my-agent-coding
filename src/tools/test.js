import { createTerminalTool } from "./terminal.js";

export function createTestTool(workspaceManager, options) {
    const terminal = createTerminalTool(workspaceManager, options);

    return function runTests(_argumentsValue, options) {
        return terminal({ command: "npm test" }, options);
    };
}
