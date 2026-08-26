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
    assert.match(prompt, /do not add its name to a path/);
    assert.match(prompt, /Application and website workflow:/);
    assert.match(prompt, /createProjectPlan before writing application files/);
    assert.match(prompt, /smallest complete solution/);
    assert.match(prompt, /Immediately read back every changed file/);
    assert.match(prompt, /Never rerun a failed test without first making and verifying a repair/);
    assert.match(prompt, /run projectReadiness after passing tests/);
    assert.match(prompt, /Use agent-source tools only for an explicit request/);
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

test("the local Ollama endpoint is the default", () => {
    assert.deepEqual(modelEndpointConfig({}), {
        apiKey: "ollama",
        baseURL: "http://127.0.0.1:11434/v1",
    });
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
