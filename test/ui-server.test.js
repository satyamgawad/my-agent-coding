import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUiServer, startUiServer } from "../src/ui-server.js";

async function startServer(server) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return `http://127.0.0.1:${port}`;
}

function basicAuthorization(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function toolCall(tool, argumentsValue = {}) {
    return JSON.stringify({ type: "tool_call", tool, arguments: argumentsValue });
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
    assert.equal(page.headers.get("x-frame-options"), "DENY");

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

test("the dashboard reports cached model route availability without exposing provider failures", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const modelHealth = {
        async check() {
            return {
                status: "degraded",
                checkedAt: "2026-08-09T12:00:00.000Z",
                cached: true,
                models: [
                    { mode: "flash", id: "flash", label: "Flash", summary: "Fast lane", available: false },
                    { mode: "ultra", id: "ultra", label: "Ultra", summary: "Balanced lane", available: true },
                ],
            };
        },
    };
    const server = createUiServer({ agentRoot: root, modelHealth });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const response = await fetch(`${baseUrl}/api/models/health`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), await modelHealth.check());
});

test("a protected dashboard requires its configured Basic Auth password", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const password = "a-long-local-dashboard-password";
    const server = createUiServer({ agentRoot: root, accessPassword: password });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const anonymous = await fetch(baseUrl);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate"), /Basic realm="My Coding Agent"/);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const wrongPassword = await fetch(baseUrl, {
        headers: { authorization: basicAuthorization("agent", "wrong-password") },
    });
    assert.equal(wrongPassword.status, 401);

    const authenticated = await fetch(baseUrl, {
        headers: { authorization: basicAuthorization("agent", password) },
    });
    assert.equal(authenticated.status, 200);
    assert.match(await authenticated.text(), /Give it a task/);
});

test("the Railway health check exposes no project data and detects unsafe project storage", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-outside-"));
    fs.symlinkSync(outside, path.join(root, "projects"), "dir");
    const server = createUiServer({ agentRoot: root, accessPassword: "a-long-local-dashboard-password" });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { status: "unavailable" });

    const context = await fetch(`${baseUrl}/api/context`);
    assert.equal(context.status, 401);
});

test("remote dashboard mode keeps project previews local-only", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const server = createUiServer({ agentRoot: root, allowProjectPreviews: false });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const status = await fetch(`${baseUrl}/api/projects/run`);
    assert.deepEqual(await status.json(), {
        state: "unavailable",
        project: null,
        url: null,
        message: "Project previews are available only in the local dashboard.",
    });

    const start = await fetch(`${baseUrl}/api/projects/run`, { method: "POST" });
    assert.equal(start.status, 403);
    assert.deepEqual(await start.json(), {
        error: "Project previews are available only in the local dashboard.",
        code: "PROJECT_PREVIEW_LOCAL_ONLY",
    });
});

test("remote dashboard startup refuses a missing or weak password", () => {
    assert.throws(
        () => startUiServer({ port: 3333, host: "0.0.0.0" }),
        /AGENT_UI_PASSWORD must be at least 16 characters/
    );
    assert.throws(
        () => startUiServer({ port: 3333, host: "0.0.0.0", accessPassword: "too-short" }),
        /AGENT_UI_PASSWORD must be at least 16 characters/
    );
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

test("a missing project file is returned as a normal task result instead of dropping the stream", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    fs.mkdirSync(path.join(root, "projects", "notepad-app"), { recursive: true });
    const responses = [
        { content: toolCall("selectProject", { name: "notepad-app" }) },
        { content: toolCall("readFile", { filePath: "public/app.js" }) },
        { content: "The requested file is missing." },
    ];
    const server = createUiServer({
        agentRoot: root,
        createModel: () => ({ async generate() { return responses.shift(); } }),
    });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const task = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Inspect the notepad client." }),
    });
    const stream = await task.text();

    assert.equal(task.status, 200);
    assert.match(stream, /FILE_NOT_FOUND/);
    assert.match(stream, /event: result/);
    assert.match(stream, /last tool action \(readFile\) failed/);
});

test("the dashboard code labels a dropped started stream as a connection interruption", () => {
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(script, /Task connection interrupted/);
    assert.match(script, /task stream ended before the agent returned a result/i);
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
