import assert from "node:assert/strict";
import test from "node:test";
import ModelRouter, {
    DEFAULT_LOCAL_MODEL,
    DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
    nemotronUltraModelFromEnvironment,
} from "../src/model-router.js";

function responseFor(profile) {
    return { content: `Response from ${profile.label}.` };
}

test("automatic routing uses the local Qwen coding model without NVIDIA", async () => {
    const used = [];
    const router = new ModelRouter({
        ultraModel: null,
        createModel: (profile) => ({
            async generate() {
                used.push(profile);
                return responseFor(profile);
            },
        }),
    });

    await router.generate("Explain the active project.");

    assert.deepEqual(used, [{
        id: DEFAULT_LOCAL_MODEL,
        label: "Qwen 2.5 Coder 7B",
        summary: "Local Ollama coding model",
        endpoint: "ollama",
    }]);
});

test("automatic routing prefers Nemotron 3 Ultra when it is configured", async () => {
    const used = [];
    const router = new ModelRouter({
        ultraModel: DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
        createModel: (profile) => ({
            async generate() {
                used.push({ id: profile.id, endpoint: profile.endpoint });
                return responseFor(profile);
            },
        }),
    });

    await router.generate("Inspect the active project.");

    assert.deepEqual(used, [{
        id: DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
        endpoint: "nvidiaUltra",
    }]);
});

test("Nemotron failures fall back to local Qwen and report the switch", async () => {
    const events = [];
    const used = [];
    const router = new ModelRouter({
        ultraModel: DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
        onRoute: (event) => events.push(event),
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                if (profile.endpoint === "nvidiaUltra") {
                    throw Object.assign(new Error("Rate limit exceeded"), { status: 429 });
                }
                return responseFor(profile);
            },
        }),
    });

    const response = await router.generate("Build a dashboard.");

    assert.equal(response.content, "Response from Qwen 2.5 Coder 7B.");
    assert.deepEqual(used, [DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL, DEFAULT_LOCAL_MODEL]);
    assert.equal(events[0].fallback, false);
    assert.equal(events[1].fallback, true);
    assert.equal(events[1].profile.id, DEFAULT_LOCAL_MODEL);
});

test("a retired NVIDIA profile is skipped for the next task", async () => {
    const unavailableProfiles = new Map();
    const retired = new ModelRouter({
        ultraModel: DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
        unavailableProfiles,
        createModel: (profile) => ({
            async generate() {
                if (profile.endpoint === "nvidiaUltra") {
                    throw Object.assign(new Error("410 status code"), { status: 410 });
                }
                return responseFor(profile);
            },
        }),
    });

    await retired.generate("Create a quick website.");

    const nextTask = new ModelRouter({
        ultraModel: DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
        unavailableProfiles,
    });
    assert.equal(nextTask.selectRoute().id, DEFAULT_LOCAL_MODEL);
});

test("authentication failures do not trigger a fallback", async () => {
    const used = [];
    const router = new ModelRouter({
        ultraModel: DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                throw Object.assign(new Error("401 status code"), { status: 401 });
            },
        }),
    });

    await assert.rejects(router.generate("Create a quick website."), { status: 401 });
    assert.deepEqual(used, [DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL]);
});

test("NVIDIA environment settings enable the automatic hosted route", () => {
    assert.equal(
        nemotronUltraModelFromEnvironment({ NVIDIA_API_KEY: "configured-key" }),
        DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL
    );
    assert.equal(
        nemotronUltraModelFromEnvironment({
            NVIDIA_NEMOTRON_ULTRA_API_KEY: "configured-key",
            NVIDIA_NEMOTRON_ULTRA_MODEL: "nvidia/custom-ultra",
        }),
        "nvidia/custom-ultra"
    );
    assert.equal(nemotronUltraModelFromEnvironment({}), null);
});
