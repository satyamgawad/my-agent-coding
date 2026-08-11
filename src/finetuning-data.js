import fs from "node:fs";
import path from "node:path";
import { nativeToolDefinitions } from "./nemotron.js";
import { validateToolArguments } from "./tools/validation.js";

const MAX_DATASET_BYTES = 10 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_MESSAGES = 32;
const MAX_MESSAGE_CHARS = 16_000;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*([:=])\s*([^\s,;]+)/gi;
const PRIVATE_TOKEN = /\b(?:nvapi-|sk-|ghp_|github_pat_)[a-z0-9_-]{8,}\b/gi;
const ROLES = new Set(["system", "user", "assistant"]);

function datasetError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function sanitizedText(value, label) {
    if (typeof value !== "string") {
        throw datasetError(`${label} must be text.`, "INVALID_TRAINING_DATA");
    }

    const sanitized = value
        .replace(/\0/g, "")
        .replace(SECRET_ASSIGNMENT, (_match, name, operator) => `${name}${operator}[REDACTED]`)
        .replace(PRIVATE_TOKEN, "[REDACTED]")
        .trim();

    if (!sanitized || sanitized.length > MAX_MESSAGE_CHARS) {
        throw datasetError(`${label} must be non-empty and at most ${MAX_MESSAGE_CHARS} characters.`, "INVALID_TRAINING_DATA");
    }

    return sanitized;
}

function cloneJson(value, label) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        throw datasetError(`${label} must be JSON-compatible.`, "INVALID_TRAINING_DATA");
    }
}

function normalizeToolCall(value, index) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "function") {
        throw datasetError(`tool_calls[${index}] must be a function call.`, "INVALID_TRAINING_DATA");
    }

    const name = value.function?.name;
    const argumentsValue = value.function?.arguments;
    const validation = validateToolArguments(name, argumentsValue);

    if (!validation.valid) {
        throw datasetError(`tool_calls[${index}] is invalid: ${validation.error}`, "INVALID_TRAINING_DATA");
    }

    return {
        type: "function",
        function: {
            name,
            arguments: cloneJson(argumentsValue, `tool_calls[${index}].function.arguments`),
        },
    };
}

function normalizeMessage(message, index) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw datasetError(`messages[${index}] must be an object.`, "INVALID_TRAINING_DATA");
    }

    if (!ROLES.has(message.role)) {
        throw datasetError(`messages[${index}].role is unsupported.`, "INVALID_TRAINING_DATA");
    }

    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    const content = typeof message.content === "string" && message.content.trim()
        ? sanitizedText(message.content, `messages[${index}].content`)
        : "";

    if (!content && !(message.role === "assistant" && hasToolCalls)) {
        throw datasetError(`messages[${index}].content must be non-empty unless it carries a tool call.`, "INVALID_TRAINING_DATA");
    }

    const normalized = { role: message.role, content };

    if (hasToolCalls) {
        if (message.role !== "assistant") {
            throw datasetError(`messages[${index}].tool_calls are allowed only for assistant messages.`, "INVALID_TRAINING_DATA");
        }

        normalized.tool_calls = message.tool_calls.map(normalizeToolCall);
    }

    return normalized;
}

/**
 * Validates and sanitizes curated examples for NVIDIA NeMo's conversational
 * JSONL format. It deliberately accepts only this agent's registered tools so
 * the fine-tuned model cannot learn arbitrary local command execution.
 */
export function normalizeFineTuneRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record) || !Array.isArray(record.messages)) {
        throw datasetError("Each training record needs a messages array.", "INVALID_TRAINING_DATA");
    }

    if (record.messages.length < 2 || record.messages.length > MAX_MESSAGES) {
        throw datasetError(`Each training record needs between 2 and ${MAX_MESSAGES} messages.`, "INVALID_TRAINING_DATA");
    }

    const messages = record.messages.map(normalizeMessage);
    const finalMessage = messages.at(-1);

    if (finalMessage.role !== "assistant") {
        throw datasetError("The final training message must be an assistant response.", "INVALID_TRAINING_DATA");
    }

    const hasToolCalls = messages.some((message) => message.tool_calls?.length > 0);
    return {
        messages,
        ...(hasToolCalls ? { tools: nativeToolDefinitions() } : {}),
    };
}

export function parseFineTuneJsonl(contents) {
    if (typeof contents !== "string") {
        throw datasetError("Training data must be UTF-8 text.", "INVALID_TRAINING_DATA");
    }

    const records = [];

    for (const [index, line] of contents.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        if (records.length >= MAX_RECORDS) {
            throw datasetError(`Training data has more than ${MAX_RECORDS} records.`, "TRAINING_DATA_TOO_LARGE");
        }

        try {
            records.push(normalizeFineTuneRecord(JSON.parse(line)));
        } catch (error) {
            if (error?.code) {
                throw datasetError(`Line ${index + 1}: ${error.message}`, error.code);
            }

            throw datasetError(`Line ${index + 1}: invalid JSON training record.`, "INVALID_TRAINING_DATA");
        }
    }

    if (records.length === 0) {
        throw datasetError("Training data must contain at least one record.", "INVALID_TRAINING_DATA");
    }

    return records;
}

export function readFineTuneJsonl(filePath) {
    const resolvedPath = path.resolve(filePath);
    const details = fs.statSync(resolvedPath);

    if (!details.isFile() || details.size > MAX_DATASET_BYTES) {
        throw datasetError("Training data must be a local JSONL file smaller than 10 MB.", "TRAINING_DATA_TOO_LARGE");
    }

    return parseFineTuneJsonl(fs.readFileSync(resolvedPath, "utf8"));
}

export function writeFineTuneJsonl(records, filePath) {
    if (!Array.isArray(records) || records.length === 0) {
        throw datasetError("Provide at least one validated training record.", "INVALID_TRAINING_DATA");
    }

    const normalized = records.map(normalizeFineTuneRecord);
    const resolvedPath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, `${normalized.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
    return { filePath: resolvedPath, records: normalized.length };
}
