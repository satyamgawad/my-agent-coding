import assert from "node:assert/strict";
import test from "node:test";
import Agent, { MAX_STEPS, normalizeToolError, normalizeToolResult } from "../src/agent.js";
import { validateToolArguments } from "../src/tools/validation.js";
import { createTestWorkspace, scriptedModel, toolCall } from "./helpers.js";

function createAgent(testContext, responses, prompts = []) {
    const { workspaceManager, tools } = createTestWorkspace(testContext);
    return {
        agent: new Agent(scriptedModel(responses, prompts), { workspaceManager, tools }),
        prompts,
        tools,
    };
}

test("tool results and errors always have a structured normalized shape", () => {
    assert.deepEqual(normalizeToolResult("readFile", "contents"), {
        ok: true,
        tool: "readFile",
        result: "contents",
        error: null,
    });
    assert.deepEqual(normalizeToolError("editFile", Object.assign(new Error("missing"), { code: "FILE_NOT_FOUND" })), {
        ok: false,
        tool: "editFile",
        result: null,
        error: { message: "missing", code: "FILE_NOT_FOUND" },
    });
});

test("tool argument validation rejects malformed, missing, and unknown fields", () => {
    assert.deepEqual(validateToolArguments("writeFile", { filePath: "a.txt" }), {
        valid: false,
        error: "missing required argument: content.",
    });
    assert.deepEqual(validateToolArguments("editFile", {
        filePath: "a.txt",
        oldText: "x",
        newText: "y",
        replaceAll: "true",
    }), { valid: false, error: "replaceAll must be a boolean." });
    assert.deepEqual(validateToolArguments("test", { force: true }), {
        valid: false,
        error: "unknown argument: force.",
    });
    assert.deepEqual(validateToolArguments("readFile", null), {
        valid: false,
        error: "arguments must be an object.",
    });
});

test("agent recovers from malformed JSON, an unknown tool, and invalid arguments", async (t) => {
    const prompts = [];
    const { agent } = createAgent(
        t,
        [
            { content: '{"type":"tool_call","tool":"listProjects"' },
            toolCall("deleteEverything"),
            toolCall("listProjects", { unexpected: true }),
            toolCall("listProjects"),
            { content: "No projects exist yet." },
        ],
        prompts
    );

    assert.equal(await agent.run("Show available projects."), "No projects exist yet.");
    assert.match(prompts[1], /MALFORMED_MODEL_RESPONSE/);
    assert.match(prompts[2], /"tool":"deleteEverything"/);
    assert.match(prompts[2], /"error":\{"message":"Unknown tool","code":"UNKNOWN_TOOL"/);
    assert.match(prompts[3], /INVALID_TOOL_ARGUMENTS/);
});

test("agent suppresses verbose model reasoning after a failed tool instead of presenting it as completion", async (t) => {
    const prompts = [];
    const { agent } = createAgent(
        t,
        [
            toolCall("createProject", { name: "Verbose" }),
            toolCall("listFiles", { directory: "verbose" }),
            {
                content:
                    "Okay, let's think through this. Wait, perhaps the path is wrong. Hmm, I should keep deliberating instead of reporting a result.",
            },
        ],
        prompts
    );

    const result = await agent.run("Inspect the project.");
    assert.match(result, /last tool action \(listFiles\) failed/);
    assert.doesNotMatch(result, /deliberating/);
    assert.match(prompts[2], /directory: "\."/);
});

test("agent blocks repetitive inspection and tells the model to implement or test next", async (t) => {
    const prompts = [];
    const { agent } = createAgent(
        t,
        [
            toolCall("createProject", { name: "Loop" }),
            ...Array.from({ length: 7 }, () =>
                toolCall("listFiles", { directory: "." })
            ),
            { content: "I only inspected files." },
        ],
        prompts
    );

    assert.match(
        await agent.run("Keep inspecting."),
        /last tool action \(listFiles\) failed/
    );
    assert.match(prompts[8], /REPEATED_INSPECTION/);
    assert.match(prompts[8], /implementation action, or run test/);
});

test("agent blocks re-selecting the already active project", async (t) => {
    const prompts = [];
    const { agent } = createAgent(
        t,
        [
            toolCall("createProject", { name: "Selected" }),
            toolCall("selectProject", { name: "selected" }),
            { content: "I selected it again." },
        ],
        prompts
    );

    assert.match(
        await agent.run("Select the active project."),
        /last tool action \(selectProject\) failed/
    );
    assert.match(prompts[2], /PROJECT_ALREADY_SELECTED/);
    assert.match(prompts[2], /already active/);
});

test("agent blocks repeated failed tests until the model changes and verifies the project", async (t) => {
    const prompts = [];
    const { agent } = createAgent(
        t,
        [
            toolCall("createProject", { name: "Failing Tests" }),
            toolCall("writeFile", {
                filePath: "package.json",
                content: JSON.stringify({ scripts: { test: "node --test missing.test.js" } }),
            }),
            toolCall("readFile", { filePath: "package.json" }),
            toolCall("test"),
            toolCall("test"),
            toolCall("test"),
            toolCall("writeFile", {
                filePath: "package.json",
                content: JSON.stringify({ scripts: { test: "node --test" } }),
            }),
            toolCall("readFile", { filePath: "package.json" }),
            toolCall("test"),
            { content: "Repaired the test setup and verified it passes." },
        ],
        prompts
    );

    assert.equal(
        await agent.run("Run tests and fix errors."),
        "Repaired the test setup and verified it passes."
    );
    assert.match(prompts[6], /REPEATED_TEST_FAILURE/);
    assert.match(prompts[6], /make a verified repair/);
});

test("agent requires an immediate file read and a later passing test after a write", async (t) => {
    const prompts = [];
    const { agent } = createAgent(
        t,
        [
            toolCall("createProject", { name: "Guard" }),
            toolCall("writeFile", { filePath: "note.txt", content: "verified\n" }),
            { content: "Done." },
        ],
        prompts
    );

    assert.equal(
        await agent.run("Create a note."),
        "❌ note.txt was modified, but verification did not complete. The agent must call readFile for that file before reporting success."
    );
    assert.match(prompts[2], /Verify the actual file/);

    const complete = createAgent(t, [
        toolCall("createProject", { name: "Complete" }),
        toolCall("writeFile", {
            filePath: "package.json",
            content: JSON.stringify({ scripts: { test: "node --test" } }),
        }),
        toolCall("readFile", { filePath: "package.json" }),
        { content: "The package file is verified." },
        toolCall("test"),
        { content: "The project was created and tested." },
    ]);
    assert.equal(
        await complete.agent.run("Create a small package."),
        "The project was created and tested."
    );
});

test("agent rejects a read-back that does not match the preceding modification", async () => {
    const prompts = [];
    let reads = 0;
    const agent = new Agent(
        scriptedModel(
            [
                toolCall("writeFile", { filePath: "note.txt", content: "expected\n" }),
                toolCall("readFile", { filePath: "note.txt" }),
                toolCall("writeFile", { filePath: "note.txt", content: "expected\n" }),
                toolCall("readFile", { filePath: "note.txt" }),
                toolCall("test"),
                { content: "Repaired and verified the note." },
            ],
            prompts
        ),
        {
            tools: {
                writeFile: {
                    execute: () => ({
                        filePath: "note.txt",
                        content: "expected\n",
                    }),
                },
                readFile: {
                    execute: () => {
                        reads += 1;
                        return reads === 1 ? "different\n" : "expected\n";
                    },
                },
                test: { execute: () => ({ exitCode: 0, stdout: "", stderr: "" }) },
            },
        }
    );

    assert.equal(await agent.run("Create a note."), "Repaired and verified the note.");
    assert.match(prompts[2], /VERIFICATION_MISMATCH/);
    assert.match(prompts[2], /Repair the file/);
});

test("agent forces recovery after a failing test until it is repaired and retested", async (t) => {
    const prompts = [];
    const { agent } = createAgent(t, [
        toolCall("createProject", { name: "Broken" }),
        toolCall("writeFile", {
            filePath: "package.json",
            content: JSON.stringify({ scripts: { test: "node --test missing.test.js" } }),
        }),
        toolCall("readFile", { filePath: "package.json" }),
        toolCall("test"),
        { content: "Everything is complete." },
        toolCall("writeFile", {
            filePath: "package.json",
            content: JSON.stringify({ scripts: { test: "node --test" } }),
        }),
        toolCall("readFile", { filePath: "package.json" }),
        toolCall("test"),
        { content: "Fixed the test configuration and confirmed the tests pass." },
    ], prompts);

    assert.equal(
        await agent.run("Create a broken project."),
        "Fixed the test configuration and confirmed the tests pass."
    );
    assert.match(prompts[5], /You must continue the task/);
});

test("agent stops safely at the maximum step limit", async (t) => {
    const { agent } = createAgent(
        t,
        Array.from({ length: MAX_STEPS }, () => toolCall("listProjects"))
    );
    const result = await agent.run("Loop forever.");
    assert.match(result, new RegExp(`Stopped after ${MAX_STEPS} agent steps`));
    assert.match(result, /Completed: listProjects:ok/);
});

test("agent retains tool history across model calls", async (t) => {
    const { workspaceManager, tools } = createTestWorkspace(t);
    const histories = [];
    const responses = [
        toolCall("listProjects"),
        toolCall("listProjects"),
        { content: "No generated projects exist." },
    ];
    const model = {
        async generate(prompt, { history }) {
            histories.push({ prompt, history: structuredClone(history) });
            return responses.shift();
        },
    };
    const agent = new Agent(model, { workspaceManager, tools });

    assert.equal(await agent.run("List the generated projects."), "No generated projects exist.");
    assert.deepEqual(histories[0].history, []);
    assert.deepEqual(histories[1].history, [
        { role: "user", content: "List the generated projects." },
        { role: "assistant", content: toolCall("listProjects").content },
    ]);
    assert.equal(histories[2].history.length, 4);
});

test("agent retries transient model request failures", async (t) => {
    const { workspaceManager, tools } = createTestWorkspace(t);
    let attempts = 0;
    const model = {
        async generate() {
            attempts += 1;

            if (attempts === 1) {
                throw new Error("Connection error");
            }

            return { content: "Ready to help." };
        },
    };
    const agent = new Agent(model, { workspaceManager, tools });

    assert.equal(await agent.run("Hello."), "Ready to help.");
    assert.equal(attempts, 2);
});

test("application tasks cannot finish before verified source, tests, and a passing test run", async (t) => {
    const prompts = [];
    const packageJson = JSON.stringify({ scripts: { test: "node --test" } });
    const { agent } = createAgent(
        t,
        [
            toolCall("createProject", { name: "Checklist" }),
            toolCall("writeFile", { filePath: "package.json", content: packageJson }),
            toolCall("readFile", { filePath: "package.json" }),
            toolCall("writeFile", { filePath: "app.js", content: "export const title = 'Checklist';\n" }),
            toolCall("readFile", { filePath: "app.js" }),
            toolCall("writeFile", {
                filePath: "app.test.js",
                content: 'import test from "node:test"; test("works", () => {});\n',
            }),
            toolCall("readFile", { filePath: "app.test.js" }),
            { content: "The application is complete." },
            toolCall("test"),
            { content: "The application is complete and verified." },
        ],
        prompts
    );

    assert.equal(
        await agent.run("Create a small checklist application."),
        "The application is complete and verified."
    );
    assert.match(prompts[8], /Run npm test successfully/);
});
