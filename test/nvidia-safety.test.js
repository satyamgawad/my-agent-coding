import assert from "node:assert/strict";
import test from "node:test";
import NvidiaSafety, { DEFAULT_NVIDIA_SAFETY_MODEL, nvidiaSafetyConfig } from "../src/nvidia-safety.js";

test("NVIDIA Safety Guard uses the configured model and blocks an unsafe classification", async () => {
    const requests = [];
    const safety = new NvidiaSafety({
        client: {
            chat: {
                completions: {
                    async create(request) {
                        requests.push(request);
                        return {
                            choices: [{
                                message: { content: "User Safety: unsafe\nResponse Safety: safe\nSafety Categories: S3" },
                            }],
                        };
                    },
                },
            },
        },
    });

    const result = await safety.inspect({ prompt: "unsafe test prompt" });

    assert.deepEqual(result, { state: "unsafe", allowed: false });
    assert.equal(requests[0].model, DEFAULT_NVIDIA_SAFETY_MODEL);
    assert.equal(requests[0].messages[0].content[0].text, "unsafe test prompt");
    assert.equal(requests[0].extra_body.chat_template_kwargs.request_categories, "/categories");
});

test("NVIDIA Safety Guard fails open when the remote provider is unavailable", async () => {
    const safety = new NvidiaSafety({
        client: {
            chat: {
                completions: {
                    async create() {
                        throw new Error("429 status code");
                    },
                },
            },
        },
    });

    assert.deepEqual(await safety.inspect({ prompt: "normal question" }), {
        state: "unavailable",
        allowed: true,
    });
});

test("NVIDIA Safety Guard configuration remains optional", () => {
    assert.equal(nvidiaSafetyConfig({}), null);
    assert.deepEqual(nvidiaSafetyConfig({ NVIDIA_API_KEY: "test-key" }), {
        apiKey: "test-key",
        baseURL: "https://integrate.api.nvidia.com/v1",
        model: DEFAULT_NVIDIA_SAFETY_MODEL,
    });
});
