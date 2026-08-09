import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import TaskHistory from "../src/task-history.js";
import WorkspaceManager from "../src/workspace.js";

test("task history persists only safe task metadata in local SQLite", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-history-test-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    const history = new TaskHistory({ workspaceManager });

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const complete = history.record({
        createdAt: "2026-08-09T12:00:00.000Z",
        project: "notes-app",
        model: "Nemotron 3 Nano",
        ok: true,
        durationMs: 43,
    });
    history.record({
        createdAt: "2026-08-09T12:01:00.000Z",
        project: "notes-app",
        model: "GLM-5.2",
        cancelled: true,
        durationMs: 12,
    });

    assert.equal(complete.status, "complete");
    assert.deepEqual(history.recent(), [
        {
            id: 2,
            createdAt: "2026-08-09T12:01:00.000Z",
            project: "notes-app",
            model: "GLM-5.2",
            status: "cancelled",
            durationMs: 12,
        },
        {
            id: 1,
            createdAt: "2026-08-09T12:00:00.000Z",
            project: "notes-app",
            model: "Nemotron 3 Nano",
            status: "complete",
            durationMs: 43,
        },
    ]);
    assert.equal(fs.existsSync(path.join(root, "projects", ".agent-data", "task-history.sqlite")), true);
    assert.deepEqual(workspaceManager.listProjects(), []);
});

test("task history rejects a symlinked local database", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-history-test-"));
    const database = path.join(root, "history.sqlite");
    const outside = path.join(root, "outside.sqlite");
    fs.writeFileSync(outside, "not a database");
    fs.symlinkSync(outside, database);

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const history = new TaskHistory({ databasePath: database });
    assert.throws(() => history.recent(), { code: "HISTORY_UNSAFE_DATABASE" });
});
