"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    normalizeDashboardUrl,
    readSse,
    streamTask,
} = require("../dashboard-client.js");

function responseStream(parts) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(encoder.encode(part));
            }
            controller.close();
        },
    });
}

test("dashboard URLs are normalized and reject embedded credentials", () => {
    assert.equal(normalizeDashboardUrl(" http://127.0.0.1:3333/ "), "http://127.0.0.1:3333");
    assert.equal(normalizeDashboardUrl("https://agent.example.test/base/"), "https://agent.example.test/base");
    assert.throws(() => normalizeDashboardUrl("javascript:alert(1)"), { code: "INVALID_DASHBOARD_URL" });
    assert.throws(() => normalizeDashboardUrl("https://agent:password@example.test"), { code: "INVALID_DASHBOARD_URL" });
    assert.throws(() => normalizeDashboardUrl("https://example.test/?token=no"), { code: "INVALID_DASHBOARD_URL" });
});

test("task stream reader parses split SSE events", async () => {
    const events = [];
    await readSse(responseStream([
        `event: ready
data: {"message":"Working"}

`,
        `event: progress
data: {"message":"Wrote file"}

`,
        `event: result
data: {"ok":true,"result":"Done"}

`,
    ]), (event) => events.push(event));

    assert.deepEqual(events, [
        { event: "ready", data: { message: "Working" } },
        { event: "progress", data: { message: "Wrote file" } },
        { event: "result", data: { ok: true, result: "Done" } },
    ]);
});

test("streamTask sends the requested mode and forwards dashboard events", async () => {
    const calls = [];
    const events = [];
    let taskId = null;
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return new Response(responseStream([
            `event: ready
data: {"message":"Working"}

`,
            `event: result
data: {"ok":true,"result":"Done"}

`,
        ]), {
            status: 200,
            headers: { "x-task-id": "task-7", "content-type": "text/event-stream" },
        });
    };

    await streamTask("http://127.0.0.1:3333", {
        task: "Improve the selected project.",
        mode: "smart",
        accessPassword: "correct horse battery staple",
        fetchImpl,
        onTaskId: (value) => { taskId = value; },
        onEvent: (event) => events.push(event),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:3333/api/tasks");
    assert.equal(calls[0].options.method, "POST");
    assert.match(calls[0].options.headers.authorization, /^Basic /);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        task: "Improve the selected project.",
        mode: "smart",
    });
    assert.equal(taskId, "task-7");
    assert.equal(events[1].data.result, "Done");
});
