import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WorkspaceManager from "../src/workspace.js";
import { createTools } from "../src/tools/index.js";

export function createTestWorkspace(testContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-test-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    const tools = createTools(workspaceManager);

    testContext.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    return { root, workspaceManager, tools };
}

export function toolCall(tool, argumentsValue = {}) {
    return {
        content: JSON.stringify({ type: "tool_call", tool, arguments: argumentsValue }),
    };
}

export function scriptedModel(responses, prompts = []) {
    return {
        async generate(prompt) {
            prompts.push(prompt);
            const response = responses.shift();

            if (!response) {
                throw new Error("The scripted model ran out of responses.");
            }

            return typeof response === "function" ? response(prompt) : response;
        },
    };
}
