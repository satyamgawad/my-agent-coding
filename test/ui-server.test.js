import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUiServer } from "../src/ui-server.js";

async function startServer(server) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return `http://127.0.0.1:${port}`;
}

test("the local UI serves its workspace context and streams agent outcomes", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const server = createUiServer({
        agentRoot: root,
        createModel: () => ({
            async generate() {
                return { content: "The task is complete." };
            },
        }),
    });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Give it a task/);
    assert.match(await (await fetch(baseUrl)).text(), /Run project/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);

    const context = await fetch(`${baseUrl}/api/context`);
    assert.deepEqual(await context.json(), {
        project: null,
        workspace: null,
        projects: [],
    });

    fs.mkdirSync(path.join(root, "projects", "notes-app"), { recursive: true });
    const selected = await fetch(`${baseUrl}/api/projects/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "notes-app" }),
    });
    assert.deepEqual(await selected.json(), {
        project: "notes-app",
        workspace: "projects/notes-app",
        projects: ["notes-app"],
    });

    const preview = await fetch(`${baseUrl}/api/projects/run`);
    assert.deepEqual(await preview.json(), {
        state: "idle",
        project: null,
        url: null,
    });

    const task = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Say hello." }),
    });
    assert.equal(task.status, 200);
    assert.match(task.headers.get("content-type"), /text\/event-stream/);
    const stream = await task.text();
    assert.match(stream, /event: ready/);
    assert.match(stream, /event: model/);
    assert.match(stream, /DeepSeek V4 Flash/);
    assert.match(stream, /event: result/);
    assert.match(stream, /The task is complete/);
});

test("the local UI rejects blank tasks without invoking the agent", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const server = createUiServer({ agentRoot: root });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "   " }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: "Describe a task before running it.",
    });
});

test("the local UI cancels only the active task and returns a final cancellation event", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    let markModelStarted;
    const modelStarted = new Promise((resolve) => {
        markModelStarted = resolve;
    });
    const server = createUiServer({
        agentRoot: root,
        createModel: () => ({
            async generate(_prompt, { signal }) {
                markModelStarted();
                return new Promise((resolve, reject) => {
                    signal.addEventListener("abort", () => reject(new Error("Request aborted.")), { once: true });
                });
            },
        }),
    });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const task = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Wait for cancellation." }),
    });
    const taskId = task.headers.get("x-task-id");
    assert.match(taskId, /^task-\d+$/);
    await modelStarted;

    const staleCancel = await fetch(`${baseUrl}/api/tasks/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "task-stale" }),
    });
    assert.equal(staleCancel.status, 409);

    const cancel = await fetch(`${baseUrl}/api/tasks/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
    });
    assert.equal(cancel.status, 202);
    assert.deepEqual(await cancel.json(), { state: "cancelling", taskId });

    const stream = await task.text();
    assert.match(stream, /Task cancelled by user/);
    assert.match(stream, /"cancelled":true/);
});
