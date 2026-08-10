import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSourceTools } from "../src/agent-source.js";

function createSourceRoot(testContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-source-test-"));
    fs.mkdirSync(path.join(root, "public"));
    fs.mkdirSync(path.join(root, "src", "tools"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"));
    fs.writeFileSync(path.join(root, "public", "app.js"), "export const label = 'old';\n");
    fs.writeFileSync(path.join(root, "src", "tools", "sandbox.js"), "export const protectedCode = true;\n");
    testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test("agent source tools allow verified improvements without exposing critical paths", (t) => {
    const root = createSourceRoot(t);
    const tools = createAgentSourceTools({ agentRoot: root });

    assert.equal(tools.readAgentSource({ filePath: "public/app.js" }), "export const label = 'old';\n");
    assert.deepEqual(tools.editAgentSource({
        filePath: "public/app.js",
        oldText: "'old'",
        newText: "'new'",
    }), {
        filePath: "public/app.js",
        content: "export const label = 'new';\n",
        bytes: 28,
        created: false,
        replacements: 1,
    });
    assert.throws(
        () => tools.writeAgentSource({ filePath: "src/tools/sandbox.js", content: "unsafe" }),
        { code: "SOURCE_WRITE_RESTRICTED" }
    );
    assert.throws(
        () => tools.readAgentSource({ filePath: ".env" }),
        { code: "SOURCE_PROTECTED_PATH" }
    );
});
