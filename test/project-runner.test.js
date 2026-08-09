import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ProjectRunner from "../src/project-runner.js";
import WorkspaceManager from "../src/workspace.js";

test("project runner starts the active project's fixed start script without exposing parent secrets", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-runner-test-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    workspaceManager.createProject("Preview");
    const workspace = workspaceManager.getActiveWorkspace();

    fs.writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ scripts: { start: "node server.js" } })
    );
    fs.writeFileSync(
        path.join(workspace, "server.js"),
        [
            "const http = require('node:http');",
            "http.createServer((request, response) => {",
            "  response.end(process.env.NVIDIA_API_KEY ? 'secret exposed' : 'preview ready');",
            "}).listen(Number(process.env.PORT), '127.0.0.1');",
        ].join("\n")
    );
    const runner = new ProjectRunner(workspaceManager);

    t.after(async () => {
        await runner.stop();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const status = await runner.run();
    assert.equal(status.state, "running");
    assert.equal(status.project, "preview");
    assert.match(status.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(status.url);
    assert.equal(await response.text(), "preview ready");

    const stopped = await runner.stop();
    assert.equal(stopped.state, "stopped");
});

test("project runner requires an active project with a start script", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-runner-test-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    const runner = new ProjectRunner(workspaceManager);

    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    await assert.rejects(runner.run(), { code: "NO_ACTIVE_PROJECT" });

    workspaceManager.createProject("No Start");
    fs.writeFileSync(path.join(workspaceManager.getActiveWorkspace(), "package.json"), "{}");
    await assert.rejects(runner.run(), { code: "PROJECT_START_UNAVAILABLE" });

    fs.writeFileSync(
        path.join(workspaceManager.getActiveWorkspace(), "package.json"),
        JSON.stringify({ scripts: { start: "node server.js --watch" } })
    );
    fs.writeFileSync(path.join(workspaceManager.getActiveWorkspace(), "server.js"), "");
    await assert.rejects(runner.run(), { code: "PROJECT_START_UNSUPPORTED" });
});
