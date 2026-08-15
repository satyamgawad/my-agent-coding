import assert from "node:assert/strict";
import test from "node:test";
import ModelRouter, {
    customModelFromEnvironment,
    DEFAULT_LOCAL_MODEL,
    DEFAULT_GEMMA_MODEL,
    DEFAULT_NVIDIA_MUSE_MODEL,
    DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
    MODEL_PROFILES,
    museModelFromEnvironment,
    nemotronUltraModelFromEnvironment,
} from "../src/model-router.js";

function responseFor(profile) {
    return { content: `Response from ${profile.label}.` };
}

test("the default route uses the free local Qwen coding model", () => {
    assert.equal(MODEL_PROFILES.local.id, DEFAULT_LOCAL_MODEL);
    assert.equal(MODEL_PROFILES.local.id, "qwen2.5-coder:7b");
    assert.match(MODEL_PROFILES.local.summary, /local Ollama/i);
});

test("automatic routing keeps the selected local model for a task", async () => {
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

    assert.deepEqual(used, [DEFAULT_LOCAL_MODEL, DEFAULT_LOCAL_MODEL]);
    assert.equal(router.activeProfile.id, DEFAULT_LOCAL_MODEL);
});

test("Auto, Build, Smart, and Local modes all use the local model by default", () => {
    for (const mode of ["auto", "build", "smart", "local"]) {
        const router = new ModelRouter({ mode, customModel: null });
        assert.equal(router.selectRoute("Build a dashboard.").id, DEFAULT_LOCAL_MODEL);
    }
});

test("Gemma uses the local reasoning model and falls back to Qwen when unavailable", async () => {
    const used = [];
    const router = new ModelRouter({
        mode: "gemma",
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                if (profile.id === DEFAULT_GEMMA_MODEL) {
                    throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
                }
                return responseFor(profile);
            },
        }),
    });

    const response = await router.generate("Summarize this project.");

    assert.equal(response.content, "Response from Qwen 2.5 Coder 7B.");
    assert.deepEqual(used, [DEFAULT_GEMMA_MODEL, DEFAULT_LOCAL_MODEL]);
});

test("Power Build routes Muse through NVIDIA and falls back to local Qwen", async () => {
    const used = [];
    const router = new ModelRouter({
        mode: "power",
        museModel: "meta/muse-glimmer-30b",
        createModel: (profile) => ({
            async generate() {
                used.push({ id: profile.id, endpoint: profile.endpoint });
                if (profile.endpoint === "nvidiaMuse") {
                    throw Object.assign(new Error("429 status code"), { status: 429 });
                }
                return responseFor(profile);
            },
        }),
    });

    const response = await router.generate("Build a polished dashboard.");

    assert.equal(response.content, "Response from Qwen 2.5 Coder 7B.");
    assert.deepEqual(used, [
        { id: "meta/muse-glimmer-30b", endpoint: "nvidiaMuse" },
        { id: DEFAULT_LOCAL_MODEL, endpoint: "ollama" },
    ]);
});

test("Nemotron 3 Ultra routes through NVIDIA and falls back to local Qwen", async () => {
    const used = [];
    const router = new ModelRouter({
        mode: "ultra",
        ultraModel: DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL,
        createModel: (profile) => ({
            async generate() {
                used.push({ id: profile.id, endpoint: profile.endpoint });
                if (profile.endpoint === "nvidiaUltra") {
                    throw Object.assign(new Error("429 status code"), { status: 429 });
                }
                return responseFor(profile);
            },
        }),
    });

    const response = await router.generate("Plan a project with careful steps.");

    assert.equal(response.content, "Response from Qwen 2.5 Coder 7B.");
    assert.deepEqual(used, [
        { id: DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL, endpoint: "nvidiaUltra" },
        { id: DEFAULT_LOCAL_MODEL, endpoint: "ollama" },
    ]);
});

test("a selected custom remote route falls back to the local model after a transient error", async () => {
    const events = [];
    const used = [];
    const router = new ModelRouter({
        mode: "custom",
        customModel: "provider/remote-coder",
        onRoute: (event) => events.push(event),
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                if (profile.id === "provider/remote-coder") {
                    throw Object.assign(new Error("Rate limit exceeded"), { code: "429" });
                }
                return responseFor(profile);
            },
        }),
    });

    const response = await router.generate("Inspect the project.");

    assert.equal(response.content, "Response from Qwen 2.5 Coder 7B.");
    assert.deepEqual(used, ["provider/remote-coder", DEFAULT_LOCAL_MODEL]);
    assert.equal(events[0].fallback, false);
    assert.equal(events[1].fallback, true);
    assert.equal(events[1].profile.id, DEFAULT_LOCAL_MODEL);
});

test("the router skips a recently retired remote profile on the next task", async () => {
    const unavailableProfiles = new Map();
    const retired = new ModelRouter({
        mode: "custom",
        customModel: "provider/remote-coder",
        unavailableProfiles,
        createModel: (profile) => ({
            async generate() {
                if (profile.id === "provider/remote-coder") {
                    throw Object.assign(new Error("410 status code (no body)"), { status: 410 });
                }
                return responseFor(profile);
            },
        }),
    });

    await retired.generate("Create a quick website.");

    const nextTask = new ModelRouter({
        mode: "custom",
        customModel: "provider/remote-coder",
        unavailableProfiles,
    });
    assert.equal(nextTask.selectRoute("Create another quick website.").id, DEFAULT_LOCAL_MODEL);
});

test("the router does not fall back after an authentication error", async () => {
    const used = [];
    const router = new ModelRouter({
        mode: "custom",
        customModel: "provider/remote-coder",
        createModel: (profile) => ({
            async generate() {
                used.push(profile.id);
                throw Object.assign(new Error("401 status code (no body)"), { status: 401 });
            },
        }),
    });

    await assert.rejects(router.generate("Create a quick website."), { status: 401 });
    assert.deepEqual(used, ["provider/remote-coder"]);
});

test("older hosted-route preferences safely map to the local route", () => {
    const router = new ModelRouter({ mode: "lightning", customModel: null });
    assert.equal(router.selectRoute("Create a quick website.").id, DEFAULT_LOCAL_MODEL);
});

test("custom routes require an explicitly configured remote model", () => {
    assert.throws(
        () => new ModelRouter({ mode: "custom", customModel: null }),
        /AGENT_MODEL is required/
    );
});

test("Power Build requires an explicitly configured Muse model ID", () => {
    assert.throws(
        () => new ModelRouter({ mode: "power", museModel: null }),
        /NVIDIA_MUSE_MODEL is required/
    );
});

test("Nemotron 3 Ultra requires a configured NVIDIA key", () => {
    assert.throws(
        () => new ModelRouter({ mode: "ultra", ultraModel: null }),
        /NVIDIA_API_KEY is required/
    );
});

test("only the provider-neutral environment variable enables a custom model", () => {
    assert.equal(
        customModelFromEnvironment({ AGENT_MODEL: "provider/current", NVIDIA_MODEL: "legacy/model" }),
        "provider/current"
    );
    assert.equal(customModelFromEnvironment({ NVIDIA_MODEL: "legacy/model" }), null);
    assert.equal(museModelFromEnvironment({ NVIDIA_MUSE_MODEL: "meta/muse-glimmer-30b" }), "meta/muse-glimmer-30b");
    assert.equal(museModelFromEnvironment({ MUSE_MODEL: "meta/muse-glimmer-30b" }), "meta/muse-glimmer-30b");
    assert.equal(museModelFromEnvironment({ NVIDIA_API_KEY: "configured-key" }), DEFAULT_NVIDIA_MUSE_MODEL);
    assert.equal(museModelFromEnvironment({}), null);
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
    assert.equal(customModelFromEnvironment({}), null);
});
