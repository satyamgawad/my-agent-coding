import assert from "node:assert/strict";
import test from "node:test";
import Nemotron, { createSystemPrompt, listNvidiaModels } from "../src/nemotron.js";
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
    assert.match(prompt, /time-sensitive, external, or specialized fact/);
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

test("Nemotron lists hosted model IDs without sending a generation request", async () => {
    let calls = 0;
    const models = await listNvidiaModels({
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
