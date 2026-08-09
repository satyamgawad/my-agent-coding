import { createTools } from "./tools/index.js";
import { validateToolArguments } from "./tools/validation.js";

export const MAX_STEPS = 30;

const INSPECTION_TOOLS = new Set(["listFiles", "readFile", "projectTree"]);
const MODIFICATION_TOOLS = new Set(["writeFile", "editFile"]);
const MAX_CONSECUTIVE_INSPECTIONS = 6;
const MAX_CONSECUTIVE_FAILED_TESTS = 2;
const MAX_MODEL_ATTEMPTS = 3;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 48 * 1024;
const MAX_TOOL_RESULT_CHARS = 16 * 1024;
const APPLICATION_TASK = /\b(app|application|website|web\s*site|portfolio|dashboard)\b/i;
const TASK_CANCELLED_RESULT = "❌ Task cancelled by user. Changes already completed were kept.";

export function normalizeToolResult(tool, result) {
    return { ok: true, tool, result, error: null };
}

export function normalizeToolError(tool, error) {
    return {
        ok: false,
        tool,
        result: null,
        error: {
            message: error instanceof Error ? error.message : String(error),
            code: error?.code || "TOOL_ERROR",
        },
    };
}

function agentError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function parseDecision(response) {
    const content = typeof response?.content === "string" ? response.content.trim() : "";

    if (!content.startsWith("{")) {
        return { decision: null, error: null };
    }

    try {
        return { decision: JSON.parse(content), error: null };
    } catch {
        return {
            decision: null,
            error: agentError(
                "Model output was not valid JSON. Return one valid tool call or a concise completion.",
                "MALFORMED_MODEL_RESPONSE"
            ),
        };
    }
}

function isPassingTest(result) {
    return result && typeof result === "object" && result.exitCode === 0;
}

function resultSummary(result) {
    return `${result.tool}:${result.ok ? "ok" : "failed"}`;
}

function commandFailure(tool, result) {
    if (
        (tool !== "terminal" && tool !== "test") ||
        !result ||
        typeof result !== "object" ||
        result.exitCode === 0
    ) {
        return null;
    }

    const output = [result.stderr, result.stdout]
        .filter(Boolean)
        .join("\n")
        .trim();
    const suffix = output ? `: ${output}` : ".";

    return agentError(
        `Command exited with code ${result.exitCode}${suffix}`,
        "COMMAND_FAILED"
    );
}

function isTestAction(tool, argumentsValue) {
    return tool === "test" || (tool === "terminal" && argumentsValue.command === "npm test");
}

function isBuildAction(tool, argumentsValue) {
    return tool === "terminal" && argumentsValue.command === "npm run build";
}

function isTestFile(filePath) {
    return /(?:^|\/)(?:test(?:s)?\/|.*\.(?:test|spec)\.[cm]?[jt]sx?$|test\.[cm]?[jt]sx?$)/.test(
        filePath
    );
}

function isTransientModelError(error) {
    const message = String(error?.message || error);
    return (
        /connection|network|timeout|temporar|rate limit|\b429\b|\b5\d\d\b/i.test(
            message
        ) ||
        ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(
            error?.code
        )
    );
}

function delay(milliseconds, signal) {
    if (!signal) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(finish, milliseconds);

        function cleanup() {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
        }

        function finish() {
            cleanup();
            resolve();
        }

        function abort() {
            cleanup();
            reject(signal.reason || new Error("Task cancelled."));
        }

        if (signal.aborted) {
            abort();
            return;
        }

        signal.addEventListener("abort", abort, { once: true });
    });
}

function boundedText(value, maximumLength) {
    if (value.length <= maximumLength) {
        return value;
    }

    const marker = "\n… [truncated for a faster, safer model request] …\n";

    if (maximumLength <= marker.length) {
        return marker.slice(0, maximumLength);
    }

    const available = maximumLength - marker.length;
    const headLength = Math.floor(available * 0.7);
    const tailLength = available - headLength;
    return `${value.slice(0, headLength)}${marker}${value.slice(-tailLength)}`;
}

function resultForPrompt(result) {
    let serialized;

    try {
        serialized = JSON.stringify(result);
    } catch {
        serialized = JSON.stringify({ ok: false, error: "Tool result could not be serialized." });
    }

    return boundedText(serialized, MAX_TOOL_RESULT_CHARS);
}

function recentHistory(history) {
    const selected = [];
    let characters = 0;

    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        const content = typeof message.content === "string" ? message.content : "";
        const remaining = MAX_HISTORY_CHARS - characters;

        if (remaining <= 0) {
            break;
        }

        if (content.length > remaining) {
            selected.unshift({ ...message, content: boundedText(content, remaining) });
            break;
        }

        selected.unshift(message);
        characters += content.length;
    }

    return selected;
}

function feedbackPrompt(task, result, instruction = "") {
    return [
        `User task:\n${task}`,
        "Latest tool result:",
        resultForPrompt(result),
        instruction,
        "Continue the task. Return exactly one JSON tool call when another action is needed. Return a concise user-facing completion only when the work is complete and verified.",
    ]
        .filter(Boolean)
        .join("\n\n");
}

export default class Agent {
    constructor(model, { workspaceManager, tools, onEvent } = {}) {
        this.model = model;
        this.workspaceManager = workspaceManager;
        this.tools = tools ?? (workspaceManager ? createTools(workspaceManager) : null);
        this.onEvent = onEvent;

        if (!this.tools) {
            throw new Error("Agent requires tools or a workspaceManager.");
        }
    }

    report(message, details) {
        this.onEvent?.({ message, details });
    }

    async generateWithRetry(prompt, history, signal) {
        let lastError;

        for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
            if (signal?.aborted) {
                throw signal.reason || new Error("Task cancelled.");
            }

            try {
                return await this.model.generate(prompt, { history, signal });
            } catch (error) {
                lastError = error;

                if (signal?.aborted) {
                    throw error;
                }

                if (!isTransientModelError(error) || attempt === MAX_MODEL_ATTEMPTS) {
                    throw error;
                }

                this.report(`model: retrying (${attempt}/${MAX_MODEL_ATTEMPTS - 1})`, {
                    ok: false,
                    error: {
                        code: "MODEL_RETRY",
                        message: error.message || String(error),
                    },
                });
                await delay(attempt * 250, signal);
            }
        }

        throw lastError;
    }

    async run(task, { signal } = {}) {
        this.model.resetTask?.();
        let prompt = task;
        let latestResult = null;
        let pendingVerification = null;
        let expectedVerificationContent = null;
        let needsPassingTest = false;
        let failedTests = 0;
        let consecutiveInspections = 0;
        const completed = [];
        const history = [];
        const applicationWorkflow = APPLICATION_TASK.test(task);
        let projectCreated = false;
        let packageVerified = false;
        let buildRequired = false;
        let buildPassed = false;
        let testPassed = false;
        const verifiedSourceFiles = new Set();
        const verifiedTestFiles = new Set();

        for (let step = 0; step < MAX_STEPS; step += 1) {
            if (signal?.aborted) {
                return TASK_CANCELLED_RESULT;
            }

            let response;

            try {
                response = await this.generateWithRetry(
                    prompt,
                    recentHistory(history.slice(-MAX_HISTORY_MESSAGES)),
                    signal
                );
            } catch (error) {
                if (signal?.aborted) {
                    return TASK_CANCELLED_RESULT;
                }

                return `❌ The model request failed: ${error.message || String(error)}`;
            }

            const content = typeof response?.content === "string" ? response.content : "";
            history.push(
                { role: "user", content: prompt },
                { role: "assistant", content }
            );
            const { decision, error: parseError } = parseDecision({ content });

            if (parseError) {
                latestResult = normalizeToolError("model", parseError);
                completed.push(resultSummary(latestResult));
                prompt = feedbackPrompt(
                    task,
                    latestResult,
                    "Return a valid tool call or a concise completion."
                );
                continue;
            }

            if (!decision || decision.type !== "tool_call") {
                if (pendingVerification) {
                    return `❌ ${pendingVerification} was modified, but verification did not complete. The agent must call readFile for that file before reporting success.`;
                }

                if (applicationWorkflow && projectCreated) {
                    let requirement;

                    if (!packageVerified) {
                        requirement = "Create package.json and verify it with readFile before reporting completion.";
                    } else if (verifiedSourceFiles.size === 0) {
                        requirement = "Create and verify at least one application source file before reporting completion.";
                    } else if (verifiedTestFiles.size === 0) {
                        requirement = "Create and verify at least one test file before reporting completion.";
                    } else if (buildRequired && !buildPassed) {
                        requirement = "Run npm run build successfully before reporting completion.";
                    } else if (!testPassed) {
                        requirement = "Run npm test successfully before reporting completion.";
                    }

                    if (requirement) {
                        prompt = feedbackPrompt(task, latestResult, requirement);
                        continue;
                    }
                }

                if (needsPassingTest) {
                    prompt = feedbackPrompt(
                        task,
                        latestResult,
                        "You must continue the task: the project has unverified changes or a failing test. Run test and repair any failure before reporting completion."
                    );
                    continue;
                }

                if (latestResult && !latestResult.ok) {
                    return `❌ The last tool action (${latestResult.tool}) failed: ${latestResult.error.message}`;
                }

                return content ||
                    (typeof response?.reasoning === "string" ? response.reasoning : "") ||
                    "Completed.";
            }

            const tool = this.tools[decision.tool];
            let result;
            let instruction = "";

            if (signal?.aborted) {
                return TASK_CANCELLED_RESULT;
            }

            if (!tool) {
                result = normalizeToolError(
                    decision.tool,
                    agentError("Unknown tool", "UNKNOWN_TOOL")
                );
            } else {
                const validation = validateToolArguments(
                    decision.tool,
                    decision.arguments
                );

                if (!validation.valid) {
                    result = normalizeToolError(
                        decision.tool,
                        agentError(validation.error, "INVALID_TOOL_ARGUMENTS")
                    );
                } else if (
                    pendingVerification &&
                    !(decision.tool === "readFile" && decision.arguments.filePath === pendingVerification)
                ) {
                    result = normalizeToolError(
                        decision.tool,
                        agentError(
                            `${pendingVerification} must be read immediately after it is modified.`,
                            "UNVERIFIED_MODIFICATION"
                        )
                    );
                    instruction = `Verify the actual file by calling readFile with filePath: ${JSON.stringify(pendingVerification)}.`;
                } else if (
                    decision.tool === "selectProject" &&
                    this.workspaceManager?.getContext().project === decision.arguments.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
                ) {
                    result = normalizeToolError(
                        decision.tool,
                        agentError("That project is already active.", "PROJECT_ALREADY_SELECTED")
                    );
                } else if (
                    INSPECTION_TOOLS.has(decision.tool) &&
                    consecutiveInspections >= MAX_CONSECUTIVE_INSPECTIONS
                ) {
                    result = normalizeToolError(
                        decision.tool,
                        agentError(
                            "Repeated inspection is not progressing the task. Make an implementation action, or run test next.",
                            "REPEATED_INSPECTION"
                        )
                    );
                } else if (
                    decision.tool === "test" &&
                    failedTests >= MAX_CONSECUTIVE_FAILED_TESTS
                ) {
                    result = normalizeToolError(
                        decision.tool,
                        agentError(
                            "Tests have failed repeatedly. Make a verified repair before testing again.",
                            "REPEATED_TEST_FAILURE"
                        )
                    );
                } else {
                    try {
                        const toolResult = await tool.execute(decision.arguments, { signal });

                        if (signal?.aborted) {
                            return TASK_CANCELLED_RESULT;
                        }

                        const executionError = commandFailure(
                            decision.tool,
                            toolResult
                        );

                        if (executionError) {
                            result = normalizeToolError(decision.tool, executionError);
                        } else if (
                            pendingVerification &&
                            decision.tool === "readFile" &&
                            decision.arguments.filePath === pendingVerification &&
                            expectedVerificationContent !== null &&
                            toolResult !== expectedVerificationContent
                        ) {
                            result = normalizeToolError(
                                decision.tool,
                                agentError(
                                    `${pendingVerification} did not match the content from the preceding modification.`,
                                    "VERIFICATION_MISMATCH"
                                )
                            );
                            pendingVerification = null;
                            expectedVerificationContent = null;
                            instruction = "The read-back content differed from the intended change. Repair the file, then read it again before continuing.";
                        } else {
                            result = normalizeToolResult(decision.tool, toolResult);
                        }
                    } catch (error) {
                        if (signal?.aborted) {
                            return TASK_CANCELLED_RESULT;
                        }

                        result = normalizeToolError(decision.tool, error);
                    }
                }
            }

            latestResult = result;
            completed.push(resultSummary(result));
            this.report(`${result.tool}: ${result.ok ? "ok" : "failed"}`, result);

            if (result.ok && MODIFICATION_TOOLS.has(result.tool)) {
                pendingVerification = decision.arguments.filePath;
                expectedVerificationContent =
                    result.tool === "writeFile"
                        ? decision.arguments.content
                        : typeof result.result?.content === "string"
                            ? result.result.content
                            : null;
                needsPassingTest = true;
                failedTests = 0;
                testPassed = false;
                if (decision.arguments.filePath === "package.json") {
                    packageVerified = false;
                    buildRequired = false;
                    buildPassed = false;
                }
                consecutiveInspections = 0;
                instruction = `Verify the actual file by calling readFile with filePath: ${JSON.stringify(pendingVerification)}.`;
            } else if (
                result.ok &&
                result.tool === "readFile" &&
                decision.arguments.filePath === pendingVerification
            ) {
                pendingVerification = null;
                expectedVerificationContent = null;
                consecutiveInspections += 1;
                if (decision.arguments.filePath === "package.json") {
                    packageVerified = true;

                    try {
                        const manifest = JSON.parse(result.result);
                        buildRequired = typeof manifest?.scripts?.build === "string";
                    } catch {
                        buildRequired = false;
                    }
                } else if (isTestFile(decision.arguments.filePath)) {
                    verifiedTestFiles.add(decision.arguments.filePath);
                } else {
                    verifiedSourceFiles.add(decision.arguments.filePath);
                }
            } else if (result.ok && INSPECTION_TOOLS.has(result.tool)) {
                consecutiveInspections += 1;
            } else if (isTestAction(result.tool, decision.arguments)) {
                const didPassTest = result.ok && isPassingTest(result.result);
                failedTests = didPassTest ? 0 : failedTests + 1;
                needsPassingTest = !didPassTest || (buildRequired && !buildPassed);
                consecutiveInspections = 0;
                if (!didPassTest) {
                    instruction = "Tests failed. Inspect the error, make a verified repair, and retest.";
                }
                if (didPassTest) {
                    testPassed = true;
                }
            } else if (isBuildAction(result.tool, decision.arguments)) {
                buildPassed = result.ok && isPassingTest(result.result);
                needsPassingTest = !buildPassed || !testPassed;
                consecutiveInspections = 0;
                if (!buildPassed) {
                    instruction = "Build failed. Inspect the error, make a verified repair, and rebuild.";
                }
            } else if (result.ok && !INSPECTION_TOOLS.has(result.tool)) {
                consecutiveInspections = 0;
            }

            if (result.ok && result.tool === "createProject") {
                projectCreated = true;
            }

            if (!result.ok && result.error.code === "REPEATED_INSPECTION") {
                instruction = "Make an implementation action, or run test next instead of inspecting again.";
            }

            if (!result.ok && result.error.code === "REPEATED_TEST_FAILURE") {
                instruction = "You must make a verified repair before testing again.";
            }

            if (!result.ok && (isTestAction(result.tool, decision.arguments) || isBuildAction(result.tool, decision.arguments))) {
                needsPassingTest = true;
                if (isTestAction(result.tool, decision.arguments)) {
                    testPassed = false;
                }
                if (isBuildAction(result.tool, decision.arguments)) {
                    buildPassed = false;
                }
            }

            if (!result.ok && result.tool === "listFiles") {
                instruction ||= 'The active project root is directory: ".". Inspect that directory or a path inside it.';
            }

            if (!result.ok && result.error.code === "FILE_NOT_FOUND") {
                if (decision.arguments.filePath === pendingVerification) {
                    pendingVerification = null;
                    expectedVerificationContent = null;
                }

                instruction ||= "That file does not exist. If it belongs in the project, use writeFile to create it and read it back. Otherwise inspect its directory or the project tree first.";
            }

            prompt = feedbackPrompt(task, result, instruction);
        }

        return `Stopped after ${MAX_STEPS} agent steps. Completed: ${completed.join(", ")}`;
    }
}
