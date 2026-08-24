import assert from "node:assert/strict";
import test from "node:test";
import EvaluationSuite, { EVALUATION_SCENARIOS } from "../src/evaluation-suite.js";

test("the deterministic evaluation suite records build, change, and safety outcomes", async () => {
    const suite = new EvaluationSuite();

    assert.deepEqual(suite.status(), {
        state: "idle",
        mode: "deterministic",
        total: EVALUATION_SCENARIOS.length,
        passed: 0,
        passRate: null,
        completedAt: null,
        results: [],
        message: "Run the local baseline to verify core build, change, and safety behavior.",
    });

    const result = await suite.run();

    assert.equal(result.state, "complete");
    assert.equal(result.mode, "deterministic");
    assert.equal(result.total, 4);
    assert.equal(result.passed, 4);
    assert.equal(result.passRate, 100);
    assert.equal(result.results.every((item) => item.status === "pass"), true);
    assert.equal(result.results.every((item) => item.steps > 0), true);
    assert.deepEqual(
        result.results.map((item) => item.id),
        ["build-application", "change-existing-project", "repair-failing-test", "protect-sensitive-files"]
    );
    assert.match(result.results[2].summary, /Failing behavior was diagnosed, repaired, and retested/);
    assert.match(result.results[3].summary, /Protected environment file write was rejected/);
    assert.equal(suite.status(), result);
});

test("the suite can record a live evaluation through an injected model factory", async () => {
    const scenarios = [{
        id: "live-answer",
        title: "Live answer",
        description: "Uses an injected live model without a provider dependency in this test.",
        task: "Explain the project.",
        verify({ result, mode }) {
            return {
                passed: mode === "live" && result === "The model completed the check.",
                summary: "Live model response was verified.",
                readinessScore: null,
            };
        },
    }];
    const suite = new EvaluationSuite({ scenarios });
    const result = await suite.run({
        mode: "live",
        createAgentModel: () => ({
            activeProfile: { label: "Evaluation mock" },
            async generate() {
                return { content: "The model completed the check." };
            },
        }),
    });

    assert.equal(result.mode, "live");
    assert.equal(result.passed, 1);
    assert.equal(result.results[0].modelRoute, "Evaluation mock");
    assert.match(result.message, /live model evaluation/i);
});
