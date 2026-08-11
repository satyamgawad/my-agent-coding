import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ProjectBrief from "../src/project-brief.js";
import WorkspaceManager from "../src/workspace.js";

function createWorkspace(testContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-brief-test-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    workspaceManager.createProject("Notes App");
    testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, workspaceManager };
}

test("Smart mode project briefs persist a compact, redacted handoff outside generated source", (t) => {
    const { root, workspaceManager } = createWorkspace(t);
    const brief = new ProjectBrief({
        workspaceManager,
        now: () => new Date("2026-08-11T12:00:00.000Z"),
    });

    const saved = brief.save({
        goal: "Add search with API_KEY=private-value.",
        plan: "Inspect the notes state, add filtered rendering, then run tests.",
        outcome: "Added search. password: private-value was not stored.",
    });

    assert.deepEqual(saved, {
        state: "ready",
        project: "notes-app",
        goal: "Add search with API_KEY=[REDACTED]",
        plan: "Inspect the notes state, add filtered rendering, then run tests.",
        outcome: "Added search. password:[REDACTED] was not stored.",
        updatedAt: "2026-08-11T12:00:00.000Z",
        message: "Saved Smart mode brief is available for the next project task.",
    });
    assert.deepEqual(new ProjectBrief({ workspaceManager }).read(), saved);
    assert.equal(
        fs.existsSync(path.join(root, "projects", ".agent-data", "project-briefs", "notes-app.json")),
        true
    );
    assert.equal(fs.existsSync(path.join(root, "projects", "notes-app", "project-brief.json")), false);
});

test("Smart mode project briefs reject unsafe local files", (t) => {
    const { root, workspaceManager } = createWorkspace(t);
    const brief = new ProjectBrief({ workspaceManager });
    const filePath = path.join(root, "projects", ".agent-data", "project-briefs", "notes-app.json");
    const outsidePath = path.join(root, "outside.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(outsidePath, "{}");
    fs.symlinkSync(outsidePath, filePath);

    assert.throws(() => brief.read(), { code: "BRIEF_UNSAFE_FILE" });
});
