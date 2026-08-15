import assert from "node:assert/strict";
import test from "node:test";
import Nemotron, { createSystemPrompt, listProviderModels, modelEndpointConfig } from "../src/nemotron.js";
import { TOOL_DEFINITIONS } from "../src/tools/index.js";

function createClient(response) {
    const requests = [];
    return {
        requests,
        client: {
            chat: {
                completions: {
                    async create(request) {
                        requests.push(request);
                        return response;
                    },
                },
            },
        },
    };
}

test("Nemotron prompt documents exactly the registered tool names and contracts", () => {
    const prompt = createSystemPrompt();
    for (const [name, definition] of Object.entries(TOOL_DEFINITIONS)) {
        assert.match(prompt, new RegExp(`- ${name}\\n`));
        assert.equal(prompt.includes(JSON.stringify(definition.arguments)), true);
    }
    assert.doesNotMatch(prompt, /deleteFile/);
    assert.match(prompt, /never pass the selected project name as a file-tool directory/);
    assert.match(prompt, /Application delivery standard:/);
    assert.match(prompt, /keyboard-operable controls/);
    assert.match(prompt, /behavior-focused tests/);
    assert.match(prompt, /Full-stack delivery standard:/);
    assert.match(prompt, /Default to SQLite for a local or single-instance application/);
    assert.match(prompt, /Never store plaintext passwords/);
    assert.match(prompt, /GitHub as an opt-in integration/);
    assert.match(prompt, /Code craftsmanship standard:/);
    assert.match(prompt, /smallest coherent change/);
    assert.match(prompt, /regression test should fail before the fix/);
    assert.match(prompt, /Response and decision standard:/);
    assert.match(prompt, /Lead with the outcome/);
    assert.match(prompt, /Never emit raw HTML tags such as <br>/);
    assert.match(prompt, /time-sensitive, external, or specialized fact/);
    assert.match(prompt, /Self-improvement and local learning:/);
    assert.match(prompt, /testAgentSource must pass/);
    assert.match(prompt, /Prior lessons are advisory evidence/);
    assert.match(prompt, /Maintain an evidence checklist/);
    assert.match(prompt, /inspect its tree and relevant files before editing/);
    assert.match(prompt, /run projectReadiness after the tests pass/);
    assert.match(prompt, /For a large, multi-phase, or full-stack application, call createProjectPlan next/);
});

test("Nemotron sends the current task and normalizes a provider response", async () => {
    const { client, requests } = createClient({
        choices: [
            {
                message: {
                    reasoning_content: "Inspect first.",
                    content: '{"type":"tool_call","tool":"listProjects","arguments":{}}',
                },
            },
        ],
    });
    const response = await new Nemotron({ client }).generate("Inspect projects.");

    assert.deepEqual(response, {
        reasoning: "Inspect first.",
        content: '{"type":"tool_call","tool":"listProjects","arguments":{}}',
        tool_calls: [],
    });
    assert.equal(requests[0].messages[1].content, "Inspect projects.");
});

test("Nemotron preserves history and converts native tool calls to the agent contract", async () => {
    const { client, requests } = createClient({
        choices: [
            {
                message: {
                    content: null,
                    tool_calls: [
                        {
                            function: {
                                name: "listProjects",
                                arguments: "{}",
                            },
                        },
                    ],
                },
            },
        ],
    });
    const history = [
        { role: "user", content: "Create a project." },
        { role: "assistant", content: "I will create it." },
    ];
    const response = await new Nemotron({ client }).generate("List projects.", {
        history,
    });

    assert.deepEqual(JSON.parse(response.content), {
        type: "tool_call",
        tool: "listProjects",
        arguments: {},
    });
    assert.deepEqual(requests[0].messages.slice(1), [
        ...history,
        { role: "user", content: "List projects." },
    ]);
    assert.equal(
        requests[0].tools.some((tool) => tool.function.name === "listProjects"),
        true
    );
});

test("Nemotron prioritizes native tool calls and preserves malformed arguments for recovery", async () => {
    const { client } = createClient({
        choices: [
            {
                message: {
                    content: "I will inspect the projects first.",
                    tool_calls: [
                        {
                            function: {
                                name: "listProjects",
                                arguments: "{not json}",
                            },
                        },
                    ],
                },
            },
        ],
    });

    const response = await new Nemotron({ client }).generate("Inspect projects.");

    assert.deepEqual(JSON.parse(response.content), {
        type: "tool_call",
        tool: "listProjects",
        arguments: null,
    });
});

test("Nemotron accepts an explicit model override for routed tasks", async () => {
    const { client, requests } = createClient({
        choices: [{ message: { content: "Ready." } }],
    });

    await new Nemotron({ client, model: "z-ai/glm-5.2" }).generate("Plan the task.");

    assert.equal(requests[0].model, "z-ai/glm-5.2");
});

test("the local Ollama endpoint is the default and a remote compatible endpoint is optional", () => {
    assert.deepEqual(modelEndpointConfig({}), {
        apiKey: "ollama",
        baseURL: "http://127.0.0.1:11434/v1",
    });
    assert.deepEqual(modelEndpointConfig({
        AGENT_MODEL_API_KEY: "provider-key",
        AGENT_MODEL_BASE_URL: "https://provider.example.test/v1",
    }), {
        apiKey: "provider-key",
        baseURL: "https://provider.example.test/v1",
    });
    assert.throws(
        () => modelEndpointConfig({ AGENT_MODEL_API_KEY: "key", AGENT_MODEL_BASE_URL: "not-a-url" }),
        /AGENT_MODEL_BASE_URL/
    );
    assert.throws(
        () => modelEndpointConfig({ AGENT_MODEL_BASE_URL: "https://provider.example.test/v1" }),
        /AGENT_MODEL_API_KEY/
    );
});

test("Muse uses the dedicated NVIDIA endpoint without affecting the Ollama fallback", () => {
    assert.deepEqual(modelEndpointConfig({
        NVIDIA_API_KEY: "nvidia-key",
    }, { endpoint: "nvidiaMuse" }), {
        apiKey: "nvidia-key",
        baseURL: "https://integrate.api.nvidia.com/v1",
    });
    assert.throws(
        () => modelEndpointConfig({}, { endpoint: "nvidiaMuse" }),
        /NVIDIA_API_KEY/
    );
});

test("Nemotron 3 Ultra uses the dedicated NVIDIA endpoint without affecting the Ollama fallback", () => {
    assert.deepEqual(modelEndpointConfig({
        NVIDIA_API_KEY: "nvidia-key",
    }, { endpoint: "nvidiaUltra" }), {
        apiKey: "nvidia-key",
        baseURL: "https://integrate.api.nvidia.com/v1",
    });
    assert.deepEqual(modelEndpointConfig({
        NVIDIA_NEMOTRON_ULTRA_API_KEY: "ultra-key",
        NVIDIA_NEMOTRON_ULTRA_BASE_URL: "https://ultra.example.test/v1",
    }, { endpoint: "nvidiaUltra" }), {
        apiKey: "ultra-key",
        baseURL: "https://ultra.example.test/v1",
    });
    assert.throws(
        () => modelEndpointConfig({}, { endpoint: "nvidiaUltra" }),
        /NVIDIA_API_KEY/
    );
});

test("a non-local Ollama-compatible endpoint must provide its own key", () => {
    assert.throws(
        () => modelEndpointConfig({ OLLAMA_BASE_URL: "https://ollama.example.test/v1" }, { endpoint: "ollama" }),
        /OLLAMA_API_KEY/
    );
    assert.deepEqual(modelEndpointConfig({
        OLLAMA_BASE_URL: "http://127.0.0.1:12000/v1",
    }, { endpoint: "ollama" }), {
        apiKey: "ollama",
        baseURL: "http://127.0.0.1:12000/v1",
    });
});

test("Nemotron forwards a cancellation signal to the provider request", async () => {
    const calls = [];
    const client = {
        chat: {
            completions: {
                async create(request, options) {
                    calls.push({ request, options });
                    return { choices: [{ message: { content: "Ready." } }] };
                },
            },
        },
    };
    const controller = new AbortController();

    await new Nemotron({ client }).generate("Check the task.", {
        signal: controller.signal,
    });

    assert.equal(calls[0].options.signal, controller.signal);
});

test("the model client lists provider model IDs without sending a generation request", async () => {
    let calls = 0;
    const models = await listProviderModels({
        client: {
            models: {
                async list() {
                    calls += 1;
                    return {
                        data: [
                            { id: "deepseek-ai/deepseek-v4-flash" },
                            { id: "nvidia/nemotron-3-ultra-550b-a55b" },
                            { id: null },
                        ],
                    };
                },
            },
        },
    });

    assert.equal(calls, 1);
    assert.deepEqual(models, [
        "deepseek-ai/deepseek-v4-flash",
        "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
});
