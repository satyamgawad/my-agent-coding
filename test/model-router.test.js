import assert from "node:assert/strict";
import test from "node:test";
import ModelRouter, { MODEL_PROFILES } from "../src/model-router.js";

function responseFor(profile) {
    return { content: `Response from ${profile.label}.` };
}

test("the built-in routes use seven open-weight models without DeepSeek", () => {
    assert.equal(MODEL_PROFILES.nano.id, "nvidia/nemotron-3-nano-30b-a3b");
    assert.equal(MODEL_PROFILES.oss.id, "openai/gpt-oss-20b");
    assert.equal(MODEL_PROFILES.llama.id, "meta/llama-3.3-70b-instruct");
    assert.equal(MODEL_PROFILES.kimi.id, "moonshotai/kimi-k2.6");
    assert.equal(MODEL_PROFILES.oss120.id, "openai/gpt-oss-120b");
    assert.doesNotMatch(JSON.stringify(MODEL_PROFILES), /deepseek/i);
});

test("automatic routing selects a lane from the task and keeps it for the task", async () => {
    const used = [];
    const router = new ModelRouter({
        customModel: null,
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                return responseFor(profile);
            },
        }),
    });

    await router.generate("Explain the active project.");
    await router.generate("Latest tool result: {}", { history: [] });

    assert.deepEqual(used, [MODEL_PROFILES.nano.id, MODEL_PROFILES.nano.id]);
    assert.equal(router.activeProfile.id, MODEL_PROFILES.nano.id);
});

test("automatic routing starts routine builds quickly and reserves deeper lanes for complex work", async () => {
    const routineBuildRouter = new ModelRouter({ customModel: null });
    const substantialRouter = new ModelRouter({ customModel: null });
    const deepWorkRouter = new ModelRouter({ customModel: null });

    assert.equal(
        routineBuildRouter.selectRoute("Create a new portfolio website.").id,
        MODEL_PROFILES.nano.id
    );
    assert.equal(
        substantialRouter.selectRoute("Build a full-stack dashboard with authentication and a database.").id,
        MODEL_PROFILES.ultra.id
    );
    assert.equal(
        deepWorkRouter.selectRoute("Design the security architecture for a migration across the system.").id,
        MODEL_PROFILES.glm.id
    );
});

test("routing is recalculated for each new agent task", () => {
    const router = new ModelRouter({ customModel: null });

    assert.equal(
        router.selectRoute("Design a security architecture migration.").id,
        MODEL_PROFILES.glm.id
    );

    router.resetTask();

    assert.equal(
        router.selectRoute("Create a simple portfolio website.").id,
        MODEL_PROFILES.nano.id
    );
});

test("the router fails over to the next model after a transient provider error", async () => {
    const events = [];
    const used = [];
    const router = new ModelRouter({
        mode: "nano",
        customModel: null,
        onRoute: (event) => events.push(event),
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                if (profile.id === MODEL_PROFILES.nano.id) {
                    throw Object.assign(new Error("Rate limit exceeded"), { code: "429" });
                }

                return responseFor(profile);
            },
        }),
    });

    const response = await router.generate("Inspect the project.");

    assert.equal(response.content, "Response from GPT-OSS 20B.");
    assert.deepEqual(used, [MODEL_PROFILES.nano.id, MODEL_PROFILES.oss.id]);
    assert.equal(events[0].fallback, false);
    assert.equal(events[1].fallback, true);
    assert.equal(events[1].profile.id, MODEL_PROFILES.oss.id);
});

test("the router falls back when a hosted model endpoint has been retired", async () => {
    const used = [];
    const router = new ModelRouter({
        mode: "nano",
        customModel: null,
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                if (profile.id === MODEL_PROFILES.nano.id) {
                    throw Object.assign(new Error("410 status code (no body)"), { status: 410 });
                }

                return responseFor(profile);
            },
        }),
    });

    const response = await router.generate("Create a quick website.");

    assert.equal(response.content, "Response from GPT-OSS 20B.");
    assert.deepEqual(used, [MODEL_PROFILES.nano.id, MODEL_PROFILES.oss.id]);
});

test("the router skips a recently retired profile for the next task", async () => {
    const unavailableProfiles = new Map();
    const retired = new ModelRouter({
        mode: "nano",
        customModel: null,
        unavailableProfiles,
        createModel: (profile) => ({
            async generate() {
                if (profile.id === MODEL_PROFILES.nano.id) {
                    throw Object.assign(new Error("410 status code (no body)"), { status: 410 });
                }

                return responseFor(profile);
            },
        }),
    });

    await retired.generate("Create a quick website.");

    const nextTask = new ModelRouter({ customModel: null, unavailableProfiles });
    assert.equal(
        nextTask.selectRoute("Create another quick website.").id,
        MODEL_PROFILES.oss.id
    );
});

test("the router does not fall back after an authentication error", async () => {
    const used = [];
    const router = new ModelRouter({
        mode: "nano",
        customModel: null,
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                throw Object.assign(new Error("401 status code (no body)"), { status: 401 });
            },
        }),
    });

    await assert.rejects(
        router.generate("Create a quick website."),
        { status: 401 }
    );
    assert.deepEqual(used, [MODEL_PROFILES.nano.id]);
});

test("an older flash mode setting safely maps to the Nano route", () => {
    const router = new ModelRouter({ mode: "flash", customModel: null });
    assert.equal(router.selectRoute("Create a quick website.").id, MODEL_PROFILES.nano.id);
});
