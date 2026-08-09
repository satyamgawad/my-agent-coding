import assert from "node:assert/strict";
import test from "node:test";
import ModelHealth from "../src/model-health.js";
import { MODEL_PROFILES } from "../src/model-router.js";

test("model health maps the provider catalog onto every configured route", async () => {
    const health = new ModelHealth({
        listModels: async () => [
            { id: MODEL_PROFILES.flash.id },
            MODEL_PROFILES.ultra.id,
            MODEL_PROFILES.glm.id,
            "unrelated/provider-model",
        ],
        now: () => Date.UTC(2026, 7, 9, 12),
    });

    const result = await health.check();

    assert.deepEqual(result, {
        status: "ready",
        checkedAt: "2026-08-09T12:00:00.000Z",
        cached: false,
        models: [
            { mode: "flash", ...MODEL_PROFILES.flash, available: true },
            { mode: "ultra", ...MODEL_PROFILES.ultra, available: true },
            { mode: "glm", ...MODEL_PROFILES.glm, available: true },
        ],
    });
});

test("model health distinguishes degraded and unavailable routes", async () => {
    const degraded = new ModelHealth({
        listModels: async () => [MODEL_PROFILES.ultra.id],
    });
    const unavailable = new ModelHealth({
        listModels: async () => [],
    });

    const degradedResult = await degraded.check();
    const unavailableResult = await unavailable.check();

    assert.equal(degradedResult.status, "degraded");
    assert.deepEqual(
        degradedResult.models.map(({ mode, available }) => ({ mode, available })),
        [
            { mode: "flash", available: false },
            { mode: "ultra", available: true },
            { mode: "glm", available: false },
        ]
    );
    assert.equal(unavailableResult.status, "unavailable");
    assert.equal(unavailableResult.models.every((profile) => !profile.available), true);
});

test("model health caches successful checks until its TTL expires", async () => {
    let now = 10_000;
    let calls = 0;
    const health = new ModelHealth({
        listModels: async () => {
            calls += 1;
            return [MODEL_PROFILES.flash.id];
        },
        ttlMs: 1_000,
        now: () => now,
    });

    const first = await health.check();
    now += 999;
    const cached = await health.check();
    now += 1;
    const refreshed = await health.check();

    assert.equal(calls, 2);
    assert.equal(first.cached, false);
    assert.equal(cached.cached, true);
    assert.equal(refreshed.cached, false);
    assert.equal(refreshed.checkedAt, "1970-01-01T00:00:11.000Z");
});

test("model health does not cache a provider failure and hides its raw error", async () => {
    let calls = 0;
    const health = new ModelHealth({
        listModels: async () => {
            calls += 1;
            throw new Error("provider token diagnostic should not reach the UI");
        },
    });

    const first = await health.check();
    const second = await health.check();

    assert.equal(calls, 2);
    assert.equal(first.status, "unknown");
    assert.equal(first.error, "Model availability could not be checked.");
    assert.doesNotMatch(JSON.stringify(first), /token diagnostic/);
    assert.equal(second.cached, false);
    assert.equal(first.models.every((profile) => profile.available === null), true);
});

test("model health can explicitly bypass a valid cached catalog", async () => {
    let calls = 0;
    const health = new ModelHealth({
        listModels: async () => {
            calls += 1;
            return [MODEL_PROFILES.flash.id];
        },
    });

    await health.check();
    const forced = await health.check({ force: true });

    assert.equal(calls, 2);
    assert.equal(forced.cached, false);
});
