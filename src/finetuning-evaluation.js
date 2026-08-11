import OpenAI from "openai";
import { modelEndpointConfig, nativeToolDefinitions } from "./nemotron.js";
import { validateToolArguments } from "./tools/validation.js";

function evaluationError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalJson);
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalJson(value[key])])
        );
    }

    return value;
}

function sameJson(left, right) {
    return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function firstToolCall(message) {
    const call = message?.tool_calls?.[0];

    if (!call?.function?.name) {
        return null;
    }

    try {
        return {
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments || "{}"),
        };
    } catch {
        return null;
    }
}

export function validateFineTuneEvaluation(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw evaluationError("Each evaluation item must be an object.", "INVALID_FINETUNE_EVALUATION");
    }

    if (typeof item.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(item.id)) {
        throw evaluationError("Evaluation ids must be lowercase hyphenated text.", "INVALID_FINETUNE_EVALUATION");
    }

    if (!Array.isArray(item.messages) || item.messages.length === 0 || item.messages.some((message) => !message || typeof message.content !== "string" || !["system", "user"].includes(message.role))) {
        throw evaluationError("Each evaluation needs system/user messages.", "INVALID_FINETUNE_EVALUATION");
    }

    if (!item.expected || typeof item.expected !== "object" || Array.isArray(item.expected)) {
        throw evaluationError("Each evaluation needs an expected result.", "INVALID_FINETUNE_EVALUATION");
    }

    const expected = { ...item.expected };

    if (expected.tool !== undefined) {
        const validation = validateToolArguments(expected.tool, expected.arguments);
        if (!validation.valid) {
            throw evaluationError(`Evaluation expected tool is invalid: ${validation.error}`, "INVALID_FINETUNE_EVALUATION");
        }
    } else if (typeof expected.contentIncludes !== "string" || !expected.contentIncludes.trim()) {
        throw evaluationError("Expected results need a tool call or contentIncludes text.", "INVALID_FINETUNE_EVALUATION");
    }

    return {
        id: item.id,
        messages: item.messages.map((message) => ({ role: message.role, content: message.content.trim() })),
        expected,
    };
}

export function scoreFineTuneResponse(item, message) {
    const evaluation = validateFineTuneEvaluation(item);

    if (evaluation.expected.tool) {
        const call = firstToolCall(message);
        const passed = call?.name === evaluation.expected.tool && sameJson(call.arguments, evaluation.expected.arguments);
        return {
            id: evaluation.id,
            status: passed ? "pass" : "fail",
            summary: passed
                ? `Called ${call.name} with the expected arguments.`
                : `Expected ${evaluation.expected.tool} with ${JSON.stringify(evaluation.expected.arguments)}.`,
        };
    }

    const content = typeof message?.content === "string" ? message.content : "";
    const passed = content.toLowerCase().includes(evaluation.expected.contentIncludes.toLowerCase());
    return {
        id: evaluation.id,
        status: passed ? "pass" : "fail",
        summary: passed
            ? "Returned the required safe completion content."
            : `Expected completion to include: ${evaluation.expected.contentIncludes}`,
    };
}

export function createFineTuneClient(environment = process.env) {
    return new OpenAI(modelEndpointConfig(environment));
}

export async function evaluateFineTunedModel(items, { client, model, signal } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
        throw evaluationError("Provide at least one fine-tuning evaluation.", "INVALID_FINETUNE_EVALUATION");
    }

    if (!client || typeof client.chat?.completions?.create !== "function") {
        throw evaluationError("An OpenAI-compatible client is required.", "FINETUNE_CLIENT_REQUIRED");
    }

    if (typeof model !== "string" || !model.trim()) {
        throw evaluationError("FINETUNE_MODEL is required for model evaluation.", "FINETUNE_MODEL_REQUIRED");
    }

    const results = [];

    for (const item of items.map(validateFineTuneEvaluation)) {
        const response = await client.chat.completions.create({
            model,
            messages: item.messages,
            tools: nativeToolDefinitions(),
            tool_choice: "auto",
            temperature: 0,
        }, { signal });
        results.push(scoreFineTuneResponse(item, response.choices?.[0]?.message));
    }

    const passed = results.filter((result) => result.status === "pass").length;
    return {
        total: results.length,
        passed,
        passRate: Math.round((passed / results.length) * 100),
        results,
    };
}
