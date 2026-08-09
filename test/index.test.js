import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments, taskFailed } from "../src/index.js";

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
});
