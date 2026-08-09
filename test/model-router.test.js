import assert from "node:assert/strict";
import test from "node:test";
import ModelRouter, { MODEL_PROFILES } from "../src/model-router.js";

function responseFor(profile) {
    return { content: `Response from ${profile.label}.` };
}

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

    assert.deepEqual(used, [MODEL_PROFILES.flash.id, MODEL_PROFILES.flash.id]);
    assert.equal(router.activeProfile.id, MODEL_PROFILES.flash.id);
});

test("automatic routing starts routine builds quickly and reserves deeper lanes for complex work", async () => {
    const routineBuildRouter = new ModelRouter({ customModel: null });
    const substantialRouter = new ModelRouter({ customModel: null });
    const deepWorkRouter = new ModelRouter({ customModel: null });

    assert.equal(
        routineBuildRouter.selectRoute("Create a new portfolio website.").id,
        MODEL_PROFILES.flash.id
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

test("the router fails over to the next model after a transient provider error", async () => {
    const events = [];
    const used = [];
    const router = new ModelRouter({
        mode: "flash",
        customModel: null,
        onRoute: (event) => events.push(event),
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                if (profile.id === MODEL_PROFILES.flash.id) {
                    throw Object.assign(new Error("Rate limit exceeded"), { code: "429" });
                }

                return responseFor(profile);
            },
        }),
    });

    const response = await router.generate("Inspect the project.");

    assert.equal(response.content, "Response from Nemotron 3 Ultra.");
    assert.deepEqual(used, [MODEL_PROFILES.flash.id, MODEL_PROFILES.ultra.id]);
    assert.equal(events[0].fallback, false);
    assert.equal(events[1].fallback, true);
    assert.equal(events[1].profile.id, MODEL_PROFILES.ultra.id);
});
