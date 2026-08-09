import OpenAI from "openai";
import "dotenv/config";
import { TOOL_DEFINITIONS } from "./tools/index.js";

const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

function argumentSchema(argumentsDefinition) {
    const properties = {};
    const required = [];

    for (const [name, description] of Object.entries(argumentsDefinition)) {
        const optional = description.includes("optional");
        properties[name] = {
            type: description.startsWith("boolean") ? "boolean" : "string",
            description: name,
        };

        if (!optional) {
            required.push(name);
        }
    }

    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}

function nativeToolDefinitions() {
    return Object.entries(TOOL_DEFINITIONS).map(([name, definition]) => ({
        type: "function",
        function: {
            name,
            description: definition.description,
            parameters: argumentSchema(definition.arguments),
        },
    }));
}

function nativeToolContent(toolCalls) {
    const toolCall = toolCalls?.[0];

    if (!toolCall?.function?.name) {
        return "";
    }

    try {
        return JSON.stringify({
            type: "tool_call",
            tool: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments || "{}"),
        });
    } catch {
        // Preserve the requested tool so the agent can return a structured
        // validation error and let the model retry instead of treating this as a
        // successful completion.
        return JSON.stringify({
            type: "tool_call",
            tool: toolCall.function.name,
            arguments: null,
        });
    }
}

function createClient() {
    const apiKey = process.env.NVIDIA_API_KEY;

    if (!apiKey) {
        throw new Error(
            "NVIDIA_API_KEY is missing. Add it to .env before running the agent."
        );
    }

    return new OpenAI({
        apiKey,
        baseURL: "https://integrate.api.nvidia.com/v1",
    });
}

function selectedModel() {
    return process.env.NVIDIA_MODEL || DEFAULT_MODEL;
}

function renderToolList() {
    return Object.entries(TOOL_DEFINITIONS)
        .map(
            ([name, definition]) => `- ${name}\n  ${definition.description}\n  arguments: ${JSON.stringify(definition.arguments)}`
        )
        .join("\n");
}

export function createSystemPrompt() {
    return `
You are My Coding Agent, a careful autonomous coding assistant.

You can only call the tools listed below. Never invent a tool name or argument. Every path must be relative to the active generated project workspace; absolute paths, path traversal, home-directory paths, .env files, .git, and node_modules are forbidden.

Available tools:
${renderToolList()}

Tool-call format:
{"type":"tool_call","tool":"exactToolName","arguments":{}}

When a tool is necessary, output exactly one valid JSON object and nothing else. Do not wrap it in Markdown. When no tool is necessary, respond with a concise user-facing completion report only. Never reveal private reasoning, deliberation, or repeated self-questioning.

Workflow:
1. Understand the request. For an existing project, inspect its tree and relevant files before editing.
2. For a new application, call createProject first. Generated applications must stay under projects/<project-name>; never write the agent's own source code. After createProject or selectProject, that project is already the active workspace: use directory "." for its root and never pass the selected project name as a file-tool directory.
3. Plan and implement a usable result, not a placeholder or one isolated file. Use writeFile for new/whole-file content and editFile for a precise existing-text replacement.
4. Immediately after every writeFile or editFile, call readFile on that exact file. The agent will reject an unverified change.
5. After the implementation is complete, run test. If package.json defines a build script, also run terminal with "npm run build". Read errors, repair them, verify repairs, and retest.
6. Do not claim success when a tool failed, a file was not verified, or tests failed. Explain completed work and verification in the final answer.
7. Prefer Node's built-in test tools (node:test and node:assert/strict) for a small project. Do not import a test library unless it is declared in package.json and installed. For a browser-only script without a DOM test environment, use a focused static-content test rather than inventing browser globals.

Terminal safety:
- terminal is allowlisted and has no working-directory argument.
- Never attempt shell operators, redirects, arbitrary commands, absolute file paths, or .. paths.
- Do not use terminal to bootstrap a project: "npm init" is unavailable. Write package.json with writeFile, read it back, then write the application and tests before running npm test or npm run build.
- Use npm install only when dependencies are genuinely necessary; it runs with package lifecycle scripts disabled.
`;
}

class Nemotron {
    constructor({ client, debug = false, model } = {}) {
        this.client = client;
        this.debug = debug;
        this.model = model;
    }

    async generate(prompt, { history = [], signal } = {}) {
        const client = this.client ??= createClient();
        const completion = await client.chat.completions.create({
            model: this.model || selectedModel(),
            messages: [
                { role: "system", content: createSystemPrompt() },
                ...history,
                { role: "user", content: prompt },
            ],
            tools: nativeToolDefinitions(),
            tool_choice: "auto",
            temperature: 0.2,
            top_p: 0.9,
            max_tokens: 4096,
            stream: false,
        }, { signal });

        const message = completion.choices[0]?.message;

        if (!message) {
            throw new Error("The NVIDIA model returned no message.");
        }

        if (this.debug) {
            console.error("[debug] NVIDIA response", {
                content: message.content,
                hasReasoning: Boolean(message.reasoning_content),
            });
        }

        const toolCalls = message.tool_calls || [];

        // Some providers return an explanatory content string alongside a native
        // tool call. The call is the actionable part of that response, so it must
        // take precedence over the companion text.
        return {
            reasoning: message.reasoning_content || "",
            content: toolCalls.length > 0
                ? nativeToolContent(toolCalls)
                : message.content || "",
            tool_calls: toolCalls,
        };
    }
}

export default Nemotron;
