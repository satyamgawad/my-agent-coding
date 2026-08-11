import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ProjectSession from "../src/project-session.js";
import WorkspaceManager from "../src/workspace.js";

function createWorkspace(testContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-session-test-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    workspaceManager.createProject("Alpha");
    testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, workspaceManager };
}

test("project conversations persist bounded follow-up context across sessions", (t) => {
    const { root, workspaceManager } = createWorkspace(t);
    const first = new ProjectSession({
        workspaceManager,
        maxTurns: 2,
        now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    first.record("alpha", { task: "First task", outcome: "First outcome" });
    first.record("alpha", { task: "Second task", outcome: "Second outcome" });
    first.record("alpha", { task: "Third task", outcome: "Third outcome" });

    const second = new ProjectSession({ workspaceManager, maxTurns: 2 });
    assert.deepEqual(second.recent("alpha"), [
        {
            task: "Second task",
            outcome: "Second outcome",
            completedAt: "2026-08-11T10:00:00.000Z",
        },
        {
            task: "Third task",
            outcome: "Third outcome",
            completedAt: "2026-08-11T10:00:00.000Z",
        },
    ]);
    assert.equal(
        fs.existsSync(path.join(root, "projects", ".agent-data", "project-conversations", "alpha.json")),
        true
    );
});

test("project conversations redact common secrets and can be cleared", (t) => {
    const { workspaceManager } = createWorkspace(t);
    const session = new ProjectSession({
        workspaceManager,
        now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    session.record("alpha", {
        task: "Use API_KEY=private-value for the request.",
        outcome: "Configured password: private-value.",
    });

    assert.deepEqual(session.recent("alpha"), [{
        task: "Use API_KEY=[REDACTED] for the request.",
        outcome: "Configured password:[REDACTED]",
        completedAt: "2026-08-11T10:00:00.000Z",
    }]);
    session.clear("alpha");
    assert.deepEqual(session.recent("alpha"), []);
});
