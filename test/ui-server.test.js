import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { createUiServer, DEFAULT_TASK_TIMEOUT_MS, resolveTaskTimeout, startUiServer } from "../src/ui-server.js";

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

test("task timeout settings stay within a safe, predictable range", () => {
    assert.equal(resolveTaskTimeout(undefined), DEFAULT_TASK_TIMEOUT_MS);
    assert.equal(resolveTaskTimeout("30000"), 30_000);
    assert.equal(resolveTaskTimeout("3600000"), 3_600_000);
    assert.equal(resolveTaskTimeout("29999"), DEFAULT_TASK_TIMEOUT_MS);
    assert.equal(resolveTaskTimeout("3600001"), DEFAULT_TASK_TIMEOUT_MS);
    assert.equal(resolveTaskTimeout("not-a-number"), DEFAULT_TASK_TIMEOUT_MS);
});

test("a hosted dashboard explains why a local Ollama route cannot connect", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const server = createUiServer({ agentRoot: root, allowProjectPreviews: false });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const task = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Hello", purpose: "chat", mode: "auto" }),
    });

    assert.equal(task.status, 400);
    assert.match((await task.json()).error, /cannot reach Ollama running on your Mac/);

    const evaluation = await fetch(`${baseUrl}/api/evaluations/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "live", modelMode: "auto" }),
    });
    assert.equal(evaluation.status, 400);
    assert.match((await evaluation.json()).error, /cannot reach Ollama running on your Mac/);
});

test("the dashboard ends a stalled model task at its configured deadline", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const server = createUiServer({
        agentRoot: root,
        taskTimeoutMs: 30,
        createModel: () => ({
            generate(_prompt, { signal }) {
                return new Promise((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
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
        body: JSON.stringify({ task: "Explain the timeout behavior." }),
    });
    const stream = await task.text();

    assert.equal(task.status, 200);
    assert.match(stream, /Task cancelled by user/);
    assert.match(stream, /"cancelled":true/);
    assert.match(stream, /"timedOut":true/);
    assert.match(stream, /"durationMs":\d+/);
});

test("the local UI serves its workspace context and streams agent outcomes", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const modelPrompts = [];
    const server = createUiServer({
        agentRoot: root,
        createModel: () => ({
            async generate(prompt) {
                modelPrompts.push(prompt);
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
    assert.match(await (await fetch(baseUrl)).text(), /Private task history/);
    assert.match(await (await fetch(baseUrl)).text(), /Source sync/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");

    const context = await fetch(`${baseUrl}/api/context`);
    assert.deepEqual(await context.json(), {
        project: null,
        workspace: null,
        projects: [],
    });

    const taskHistory = await fetch(`${baseUrl}/api/tasks/history`);
    assert.deepEqual(await taskHistory.json(), {
        state: "ready",
        records: [],
        message: "Recent task outcomes are saved locally. Task prompts and model responses are not stored.",
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
    assert.match(stream, /Nemotron 3 Ultra/);
    assert.match(stream, /event: result/);
    assert.match(stream, /The task is complete/);
    assert.match(stream, /"durationMs":\d+/);
    assert.match(stream, /"steps":0/);

    const completedHistory = await fetch(`${baseUrl}/api/tasks/history`);
    const historyBody = await completedHistory.json();
    assert.equal(historyBody.records.length, 1);
    assert.equal(historyBody.records[0].status, "complete");
    assert.equal(historyBody.records[0].project, "notes-app");
    assert.equal(historyBody.records[0].model, "Nemotron 3 Ultra");
    assert.equal(Object.hasOwn(historyBody.records[0], "task"), false);

    const followUp = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Change the greeting." }),
    });
    assert.equal(followUp.status, 200);
    await followUp.text();
    assert.match(modelPrompts[1], /Recent saved agent conversation/);
    assert.match(modelPrompts[1], /Say hello/);
    assert.match(modelPrompts[1], /The task is complete/);

    const conversation = await fetch(`${baseUrl}/api/conversation`);
    const conversationBody = await conversation.json();
    assert.equal(conversationBody.state, "ready");
    assert.equal(conversationBody.turns.length, 2);
    assert.equal(conversationBody.turns[0].task, "Say hello.");

    const cleared = await fetch(`${baseUrl}/api/conversation/clear`, { method: "POST" });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await cleared.json()).turns, []);
});

test("the dashboard saves an ongoing agent conversation before a project exists", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const server = createUiServer({
        agentRoot: root,
        createModel: () => ({
            async generate() {
                return { content: "A project is not needed for this answer." };
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
        body: JSON.stringify({ task: "Explain the available tools." }),
    });
    assert.equal(task.status, 200);
    await task.text();

    const conversation = await fetch(`${baseUrl}/api/conversation`);
    assert.deepEqual((await conversation.json()).turns.map(({ task: prompt, outcome }) => ({ prompt, outcome })), [{
        prompt: "Explain the available tools.",
        outcome: "A project is not needed for this answer.",
    }]);
});

test("general chat stays separate from project context and project conversations", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const prompts = [];
    const server = createUiServer({
        agentRoot: root,
        createModel: () => ({
            async generate(prompt) {
                prompts.push(prompt);
                return { content: "A clear general answer." };
            },
        }),
    });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    fs.mkdirSync(path.join(root, "projects", "notes-app"), { recursive: true });
    await fetch(`${baseUrl}/api/projects/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "notes-app" }),
    });

    const chat = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "What is a REST API?", purpose: "chat" }),
    });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /A clear general answer/);
    assert.match(prompts[0], /general Chat mode/);
    assert.match(prompts[0], /cannot inspect files, open projects, create projects, run commands, or change anything/i);
    assert.match(prompts[0], /may use only webSearch and readWebPage/i);

    const generalChat = await fetch(`${baseUrl}/api/chat/conversation`);
    assert.deepEqual((await generalChat.json()).turns.map(({ task, outcome }) => ({ task, outcome })), [{
        task: "What is a REST API?",
        outcome: "A clear general answer.",
    }]);

    const projectConversation = await fetch(`${baseUrl}/api/conversation`);
    assert.deepEqual((await projectConversation.json()).turns, []);

    const history = await fetch(`${baseUrl}/api/tasks/history`);
    assert.equal((await history.json()).records[0].project, null);
});

test("the optional NVIDIA Safety Guard checks requests and answers without blocking a local fallback", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const checks = [];
    const server = createUiServer({
        agentRoot: root,
        createModel: () => ({
            async generate() {
                return { content: "A safe answer." };
            },
        }),
        safety: {
            async inspect(input) {
                checks.push(input);
                return { state: "safe", allowed: true };
            },
        },
    });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const task = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Explain safety checks.", purpose: "chat", safety: true }),
    });
    const stream = await task.text();

    assert.match(stream, /safety: checking request/);
    assert.match(stream, /safety: request approved/);
    assert.match(stream, /safety: checking answer/);
    assert.match(stream, /safety: answer approved/);
    assert.match(stream, /A safe answer/);
    assert.equal(checks.length, 2);
    assert.equal(checks[0].prompt, "Explain safety checks.");
    assert.equal(checks[1].response, "A safe answer.");
});

test("the dashboard runs Smart mode and exposes its saved project handoff", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const server = createUiServer({
        agentRoot: root,
        createModel: () => ({
            async generate(prompt) {
                if (prompt.includes("Smart planning pass")) {
                    return { content: "Goal: improve the notes project. Approach: inspect and update the selected project. Verify: run its tests." };
                }

                if (prompt.includes("Smart completion review")) {
                    return { content: "VERDICT: APPROVED" };
                }

                return { content: "Improved the selected project." };
            },
        }),
    });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    fs.mkdirSync(path.join(root, "projects", "notes-app"), { recursive: true });
    await fetch(`${baseUrl}/api/projects/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "notes-app" }),
    });

    const task = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Improve the selected project.", mode: "smart" }),
    });
    assert.equal(task.status, 200);
    const stream = await task.text();
    assert.match(stream, /smart: creating implementation brief/);
    assert.match(stream, /smart: reviewing completion/);
    assert.match(stream, /Improved the selected project/);

    const brief = await fetch(`${baseUrl}/api/projects/brief`);
    const briefBody = await brief.json();
    assert.equal(briefBody.state, "ready");
    assert.match(briefBody.goal, /Improve the selected project/);
    assert.match(briefBody.plan, /inspect and update/i);
    assert.match(briefBody.outcome, /Improved the selected project/);
});

test("the dashboard exposes configured GitHub publishing only after repository confirmation", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const calls = [];
    const githubPublisher = {
        status() {
            return {
                state: "ready",
                configured: true,
                repository: "owner/generated-apps",
                branch: "main",
                message: "Ready to publish safe source files to owner/generated-apps (main).",
            };
        },
        async publish({ confirmation }) {
            calls.push(confirmation);
            if (confirmation !== "owner/generated-apps") {
                const error = new Error("Confirm the configured GitHub repository before publishing.");
                error.code = "GITHUB_REPOSITORY_NOT_CONFIRMED";
                error.status = 409;
                throw error;
            }
            return { state: "complete", total: 2, created: 2, updated: 0, repository: "owner/generated-apps" };
        },
    };
    const server = createUiServer({ agentRoot: root, githubPublisher });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const status = await fetch(`${baseUrl}/api/github`);
    assert.deepEqual(await status.json(), githubPublisher.status());

    const denied = await fetch(`${baseUrl}/api/github/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "owner/wrong" }),
    });
    assert.equal(denied.status, 409);
    assert.equal(calls.length, 1);

    const published = await fetch(`${baseUrl}/api/github/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "owner/generated-apps" }),
    });
    assert.equal(published.status, 200);
    assert.deepEqual(await published.json(), { state: "complete", total: 2, created: 2, updated: 0, repository: "owner/generated-apps" });
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

test("the dashboard reports deterministic engineering readiness for the active project", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const project = path.join(root, "projects", "calculator");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
        scripts: { test: "node --test", build: "node --check app.js" },
    }));
    fs.writeFileSync(path.join(project, "app.js"), "export const add = (left, right) => left + right;\n");
    fs.writeFileSync(path.join(project, "app.test.js"), 'import assert from "node:assert/strict"; import test from "node:test"; test("adds", () => assert.equal(2 + 3, 5));\n');
    fs.writeFileSync(path.join(project, "README.md"), "# Calculator\n");
    const server = createUiServer({ agentRoot: root });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const idle = await fetch(`${baseUrl}/api/projects/evaluation`);
    assert.deepEqual(await idle.json(), {
        state: "idle",
        project: null,
        score: 0,
        message: "Select a project to see its local engineering readiness checks.",
        checks: [],
    });

    const idlePlan = await fetch(`${baseUrl}/api/projects/plan`);
    assert.deepEqual(await idlePlan.json(), {
        state: "idle",
        project: null,
        goal: null,
        progress: { completed: 0, total: 0 },
        milestones: [],
        message: "Select a project to see its saved milestone plan.",
    });

    await fetch(`${baseUrl}/api/projects/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "calculator" }),
    });
    const evaluation = await fetch(`${baseUrl}/api/projects/evaluation`);
    const body = await evaluation.json();

    assert.equal(evaluation.status, 200);
    assert.equal(evaluation.headers.get("cache-control"), "no-store");
    assert.equal(body.state, "ready");
    assert.equal(body.score, 100);
    assert.equal(body.checks.every((item) => item.status === "pass"), true);
});

test("the dashboard exposes and runs isolated agent baseline evaluations", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const server = createUiServer({ agentRoot: root });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const idle = await fetch(`${baseUrl}/api/evaluations`);
    assert.equal(idle.status, 200);
    assert.deepEqual(await idle.json(), {
        state: "idle",
        mode: "deterministic",
        total: 4,
        passed: 0,
        passRate: null,
        completedAt: null,
        results: [],
        message: "Run the local baseline to verify core build, change, and safety behavior.",
    });

    const run = await fetch(`${baseUrl}/api/evaluations/run`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ mode: "deterministic" }),
    });
    const result = await run.json();

    assert.equal(run.status, 200);
    assert.equal(result.state, "complete");
    assert.equal(result.passed, 4);
    assert.equal(result.passRate, 100);
    assert.equal(result.results.every((item) => item.status === "pass"), true);
    assert.equal(result.results.every((item) => item.modelRoute === "deterministic fixture"), true);

    const completed = await fetch(`${baseUrl}/api/evaluations`);
    assert.deepEqual(await completed.json(), result);
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

test("authenticated static previews and source downloads stay sandboxed and within the active project", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-outside-"));
    const password = "a-long-local-dashboard-password";
    const project = path.join(root, "projects", "tic-tac-toe");
    fs.mkdirSync(path.join(project, "public"), { recursive: true });
    fs.writeFileSync(path.join(project, "public", "index.html"), "<main>Tic Tac Toe</main>");
    fs.writeFileSync(path.join(project, "public", "app.js"), "console.log('game ready');");
    fs.writeFileSync(path.join(project, ".env"), "NVIDIA_API_KEY=secret");
    fs.writeFileSync(path.join(outside, "secret.js"), "outside secret");
    fs.symlinkSync(path.join(outside, "secret.js"), path.join(project, "public", "linked.js"));
    const server = createUiServer({ agentRoot: root, accessPassword: password });
    const baseUrl = await startServer(server);
    const authorization = basicAuthorization("agent", password);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    const anonymous = await fetch(`${baseUrl}/api/projects/preview/`);
    assert.equal(anonymous.status, 401);

    const selected = await fetch(`${baseUrl}/api/projects/select`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "tic-tac-toe" }),
    });
    assert.equal(selected.status, 200);

    const status = await fetch(`${baseUrl}/api/projects/preview`, { headers: { authorization } });
    assert.deepEqual(await status.json(), {
        state: "ready",
        available: true,
        project: "tic-tac-toe",
        url: "/api/projects/preview/",
        downloadUrl: "/api/projects/download",
        message: null,
    });

    const preview = await fetch(`${baseUrl}/api/projects/preview/`, { headers: { authorization } });
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /Tic Tac Toe/);
    assert.equal(preview.headers.get("x-frame-options"), null);
    const csp = preview.headers.get("content-security-policy");
    for (const directive of [
        "sandbox allow-scripts",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'self'",
    ]) {
        assert.ok(csp.includes(directive));
    }

    for (const forbiddenPath of [".env", "linked.js", "%2e%2e%2f.env", "%2e%2e%5c.env"]) {
        const response = await fetch(`${baseUrl}/api/projects/preview/${forbiddenPath}`, {
            headers: { authorization },
        });
        assert.equal(response.status, 404);
        assert.doesNotMatch(await response.text(), /secret/i);
    }

    const download = await fetch(`${baseUrl}/api/projects/download`, { headers: { authorization } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type"), /application\/gzip/);
    assert.match(download.headers.get("content-disposition"), /tic-tac-toe-source\.tar\.gz/);
    const source = gunzipSync(Buffer.from(await download.arrayBuffer())).toString("utf8");
    assert.match(source, /Tic Tac Toe/);
    assert.doesNotMatch(source, /NVIDIA_API_KEY|outside secret/);
});

test("the authenticated active-task status supports dashboard recovery without exposing task data", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const password = "a-long-local-dashboard-password";
    let markModelStarted;
    const modelStarted = new Promise((resolve) => {
        markModelStarted = resolve;
    });
    const server = createUiServer({
        agentRoot: root,
        accessPassword: password,
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
    const authorization = basicAuthorization("agent", password);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const task = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ task: "This prompt must remain private." }),
    });
    const taskId = task.headers.get("x-task-id");
    await modelStarted;

    const anonymous = await fetch(`${baseUrl}/api/tasks/active`);
    assert.equal(anonymous.status, 401);

    const active = await fetch(`${baseUrl}/api/tasks/active`, { headers: { authorization } });
    assert.equal(active.status, 200);
    assert.equal(active.headers.get("cache-control"), "no-store");
    assert.deepEqual(await active.json(), { state: "working", taskId });

    const duplicate = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ task: "A second task must not start." }),
    });
    assert.equal(duplicate.status, 409);

    const cancel = await fetch(`${baseUrl}/api/tasks/cancel`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
    });
    assert.equal(cancel.status, 202);
    await task.text();

    const idle = await fetch(`${baseUrl}/api/tasks/active`, { headers: { authorization } });
    assert.deepEqual(await idle.json(), { state: "idle", taskId: null });
});

test("the dashboard locks project selection while an agent task is active", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    fs.mkdirSync(path.join(root, "projects", "first-project"), { recursive: true });
    fs.mkdirSync(path.join(root, "projects", "second-project"), { recursive: true });
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

    const selectFirst = await fetch(`${baseUrl}/api/projects/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "first-project" }),
    });
    assert.equal(selectFirst.status, 200);

    const task = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Wait for cancellation." }),
    });
    const taskId = task.headers.get("x-task-id");
    await modelStarted;

    const blocked = await fetch(`${baseUrl}/api/projects/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "second-project" }),
    });
    assert.equal(blocked.status, 409);
    assert.deepEqual(await blocked.json(), {
        error: "Wait for the active task to finish before changing projects.",
        code: "ACTIVE_TASK_WORKSPACE_LOCKED",
    });

    const context = await fetch(`${baseUrl}/api/context`);
    assert.equal((await context.json()).project, "first-project");

    await fetch(`${baseUrl}/api/tasks/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
    });
    await task.text();
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

test("the dashboard explains how to configure the Muse Power Build route", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const savedNvidiaApiKey = process.env.NVIDIA_API_KEY;
    const savedNvidiaMuseApiKey = process.env.NVIDIA_MUSE_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_MUSE_API_KEY;
    const server = createUiServer({ agentRoot: root });
    const baseUrl = await startServer(server);

    t.after(async () => {
        if (savedNvidiaApiKey === undefined) delete process.env.NVIDIA_API_KEY;
        else process.env.NVIDIA_API_KEY = savedNvidiaApiKey;
        if (savedNvidiaMuseApiKey === undefined) delete process.env.NVIDIA_MUSE_API_KEY;
        else process.env.NVIDIA_MUSE_API_KEY = savedNvidiaMuseApiKey;
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Build a dashboard.", mode: "power" }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: "Muse Power Build needs NVIDIA_MUSE_MODEL in .env. Add the exact model ID from your NVIDIA API Catalog page, then restart the dashboard.",
    });
});

test("the dashboard explains how to configure the Nemotron 3 Ultra route", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    const savedNvidiaApiKey = process.env.NVIDIA_API_KEY;
    const savedUltraApiKey = process.env.NVIDIA_NEMOTRON_ULTRA_API_KEY;
    const savedUltraModel = process.env.NVIDIA_NEMOTRON_ULTRA_MODEL;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_NEMOTRON_ULTRA_API_KEY;
    delete process.env.NVIDIA_NEMOTRON_ULTRA_MODEL;
    const server = createUiServer({ agentRoot: root });
    const baseUrl = await startServer(server);

    t.after(async () => {
        if (savedNvidiaApiKey === undefined) delete process.env.NVIDIA_API_KEY;
        else process.env.NVIDIA_API_KEY = savedNvidiaApiKey;
        if (savedUltraApiKey === undefined) delete process.env.NVIDIA_NEMOTRON_ULTRA_API_KEY;
        else process.env.NVIDIA_NEMOTRON_ULTRA_API_KEY = savedUltraApiKey;
        if (savedUltraModel === undefined) delete process.env.NVIDIA_NEMOTRON_ULTRA_MODEL;
        else process.env.NVIDIA_NEMOTRON_ULTRA_MODEL = savedUltraModel;
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Explain a system design.", mode: "ultra", purpose: "chat" }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: "Nemotron 3 Ultra needs NVIDIA_API_KEY in .env. Add your NVIDIA API Catalog key, then restart the dashboard.",
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

test("the dashboard disables workspace-changing controls until active task state is known", () => {
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(script, /const taskControlsDisabled = isRunning \|\| !taskStatusKnown/);
    assert.match(script, /document\.querySelectorAll\("\[data-prompt\], #project-list button"\)/);
    assert.match(script, /button\.disabled = !taskStatusKnown \|\| Boolean\(activeTaskId\)/);
});

test("the dashboard renders local project readiness checks", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /PROJECT READINESS/);
    assert.match(page, /id="evaluation-score"/);
    assert.match(script, /\/api\/projects\/evaluation/);
    assert.match(script, /renderProjectEvaluation/);
});

test("the dashboard renders private milestone progress for large projects", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /MILESTONE PLAN/);
    assert.match(page, /id="plan-milestones"/);
    assert.match(script, /\/api\/projects\/plan/);
    assert.match(script, /renderProjectPlan/);
});

test("the dashboard uses one automatic model route", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /Automatic route: NVIDIA Nemotron 3 Ultra when configured/);
    assert.doesNotMatch(page, /id="model-mode"/);
    assert.doesNotMatch(page, /id="chat-model-mode"/);
    assert.doesNotMatch(page, /id="plan-review"/);
    assert.doesNotMatch(page, /data-build-prompt/);
    assert.match(script, /mode: "auto"/);
    assert.doesNotMatch(script, /modelNotes/);
    assert.doesNotMatch(script, /CHAT_MODEL_MODE_STORAGE_KEY/);
});

test("the dashboard guides a generic project request into a requirements brief", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /id="requirements-guide"/);
    assert.match(page, /id="requirements-starter"/);
    assert.match(page, /id="project-task-count"/);
    assert.match(script, /function isRequirementsPrompt/);
    assert.match(script, /function setRequirementsGuide/);
    assert.match(script, /function updateProjectTaskCount/);
    assert.match(script, /Project brief requested/);
});

test("the dashboard exposes an opt-in NVIDIA Safety Guard toggle", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /id="safety-guard"/);
    assert.match(page, /NVIDIA Safety/);
    assert.match(script, /SAFETY_GUARD_STORAGE_KEY/);
    assert.match(script, /safety: safetyGuard\.checked/);
    assert.match(script, /restoreSafetyGuardPreference/);
});

test("the dashboard formats agent answers without rendering raw HTML break tags", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.doesNotMatch(page, /<br\s*\/?\s*>/i);
    assert.match(script, /function renderAnswerText/);
    assert.match(script, /function cleanAnswerText/);
    assert.match(script, /renderAnswerText\(resultText, text\)/);
});

test("the dashboard renders a scrolling moon and solar-system background", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const styles = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.doesNotMatch(page, /https:\/\/cdn\.tailwindcss\.com/);
    assert.match(page, /class="cosmic-backdrop"/);
    assert.match(page, /class="moon"/);
    assert.match(styles, /\.orbital-system/);
    assert.match(script, /function updateCosmicParallax/);
    assert.match(script, /window\.addEventListener\("scroll"/);
    assert.match(styles, /prefers-reduced-motion/);
});

test("the dashboard renders and clears the saved agent conversation", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /AGENT CONVERSATION/);
    assert.match(page, /id="conversation-turns"/);
    assert.match(page, /id="clear-conversation"/);
    assert.match(script, /\/api\/conversation/);
    assert.match(script, /clearProjectConversation/);
});

test("the dashboard renders and starts the agent baseline evaluation suite", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /AGENT EVALUATIONS/);
    assert.match(page, /id="run-evaluations"/);
    assert.match(page, /id="run-live-evaluations"/);
    assert.match(script, /\/api\/evaluations\/run/);
    assert.match(script, /runAgentEvaluations/);
    assert.match(script, /runAgentEvaluations\("live"\)/);
});

test("the dashboard restores an active task after a reload or a 409 task collision", () => {
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(script, /fetch\("\/api\/tasks\/active"/);
    assert.match(script, /Recovered active task/);
    assert.match(script, /response\.status === 409/);
    assert.match(script, /startActiveTaskPolling/);
});

test("the dashboard opens generated static previews in a new tab", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /id="preview-project"[^>]*target="_blank"[^>]*rel="noopener"/);
    assert.doesNotMatch(page, /<iframe/);
    assert.match(page, /id="delete-project"/);
    assert.match(script, /\/api\/projects\/preview/);
    assert.match(script, /\/api\/projects\/download/);
    assert.match(script, /\/api\/projects\/delete/);
});

test("the dashboard renders live activity, file updates, expandable context, and notifications", () => {
    const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(page, /id="activity-count"/);
    assert.match(page, /id="file-change-list"/);
    assert.match(page, /id="toast-region"/);
    assert.match(page, /data-panel-toggle="conversation-content"/);
    assert.doesNotMatch(page, /project-brief-content/);
    assert.match(script, /function addFileChange/);
    assert.match(script, /function showToast/);
    assert.match(script, /FILE_CHANGE_TOOLS/);
    assert.doesNotMatch(script, /MODEL_MODE_STORAGE_KEY/);
    assert.doesNotMatch(script, /refreshProjectBrief/);
});

test("the dashboard deletes only the selected local project after exact confirmation", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-ui-test-"));
    fs.mkdirSync(path.join(root, "projects", "delete-me"), { recursive: true });
    fs.mkdirSync(path.join(root, "projects", "keep-me"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "delete-me", "index.html"), "<main>Delete</main>");
    const server = createUiServer({ agentRoot: root });
    const baseUrl = await startServer(server);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const selected = await fetch(`${baseUrl}/api/projects/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "delete-me" }),
    });
    assert.equal(selected.status, 200);

    const unconfirmed = await fetch(`${baseUrl}/api/projects/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "delete-me", confirmation: "wrong" }),
    });
    assert.equal(unconfirmed.status, 400);
    assert.deepEqual(await unconfirmed.json(), {
        error: "Type the full project name to confirm deletion.",
        code: "PROJECT_DELETE_NOT_CONFIRMED",
    });
    assert.equal(fs.existsSync(path.join(root, "projects", "delete-me")), true);

    const deleted = await fetch(`${baseUrl}/api/projects/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "delete-me", confirmation: "delete-me" }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), {
        project: null,
        workspace: null,
        projects: ["keep-me"],
    });
    assert.equal(fs.existsSync(path.join(root, "projects", "delete-me")), false);
    assert.equal(fs.existsSync(path.join(root, "projects", "keep-me")), true);
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
