import assert from "node:assert/strict";
import test from "node:test";
import ProjectSession from "../src/project-session.js";

test("project sessions keep only bounded in-memory follow-up context per project", () => {
    const session = new ProjectSession({ maxTurns: 2 });
    session.record("alpha", { task: "First task", outcome: "First outcome" });
    session.record("beta", { task: "Other project", outcome: "Other outcome" });
    session.record("alpha", { task: "Second task", outcome: "Second outcome" });
    session.record("alpha", { task: "Third task", outcome: "Third outcome" });

    assert.deepEqual(session.recent("alpha"), [
        { task: "Second task", outcome: "Second outcome" },
        { task: "Third task", outcome: "Third outcome" },
    ]);
    assert.deepEqual(session.recent("beta"), [
        { task: "Other project", outcome: "Other outcome" },
    ]);
    assert.deepEqual(session.recent("missing"), []);
});

test("project sessions reject incomplete turns and remove null bytes", () => {
    const session = new ProjectSession();
    session.record("alpha", { task: "", outcome: "ignored" });
    session.record("alpha", { task: "Follow\0up", outcome: "Done\0" });

    assert.deepEqual(session.recent("alpha"), [
        { task: "Followup", outcome: "Done" },
    ]);
});
