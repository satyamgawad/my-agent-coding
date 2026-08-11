import assert from "node:assert/strict";
import test from "node:test";
import {
    parseArguments,
    runRememberedTask,
    taskFailed,
} from "../src/index.js";
import ProjectSession, { AGENT_CONVERSATION_ID } from "../src/project-session.js";

test("CLI argument parsing keeps the task while recognizing help and debug flags", () => {
    assert.deepEqual(
        parseArguments(["--debug", "Create", "a", "Todo", "app"]),
        { debug: true, help: false, task: "Create a Todo app" }
    );
    assert.deepEqual(parseArguments(["--help"]), {
        debug: false,
        help: true,
        task: "",
    });
});

test("one-shot task failures produce a non-zero process status", () => {
    assert.equal(taskFailed("❌ A tool failed."), true);
    assert.equal(taskFailed("Stopped after 30 agent steps. Completed: test:failed"), true);
    assert.equal(taskFailed("Created and verified the project."), false);
    assert.equal(taskFailed(null), false);
});

test("one-shot and interactive CLI tasks share the saved agent conversation", async () => {
    const session = new ProjectSession({
        now: () => new Date("2026-08-11T12:00:00.000Z"),
    });
    session.record(AGENT_CONVERSATION_ID, {
        task: "Create a notes app.",
        outcome: "Created the notes app.",
    });
    const received = [];
    const agent = {
        async run(task, options) {
            received.push({ task, options });
            return "Added search to the notes app.";
        },
    };

    const result = await runRememberedTask(agent, "Add search.", session);
    assert.equal(result, "Added search to the notes app.");

    assert.deepEqual(received, [{
        task: "Add search.",
        options: {
            sessionContext: [{
                task: "Create a notes app.",
                outcome: "Created the notes app.",
                completedAt: "2026-08-11T12:00:00.000Z",
            }],
        },
    }]);
    assert.deepEqual(session.recent(AGENT_CONVERSATION_ID).map((turn) => ({
        task: turn.task,
        outcome: turn.outcome,
    })), [
        {
            task: "Create a notes app.",
            outcome: "Created the notes app.",
        },
        {
            task: "Add search.",
            outcome: "Added search to the notes app.",
        },
    ]);
});
