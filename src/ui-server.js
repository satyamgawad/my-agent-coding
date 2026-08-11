import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Agent from "./agent.js";
import EvaluationSuite from "./evaluation-suite.js";
import GitHubPublisher from "./github-publisher.js";
import ModelHealth from "./model-health.js";
import ModelRouter, { MODEL_MODES } from "./model-router.js";
import Nemotron, { listNvidiaModels } from "./nemotron.js";
import ProjectArtifacts from "./project-artifacts.js";
import ProjectBrief from "./project-brief.js";
import { ProjectEvaluator } from "./project-intelligence.js";
import ProjectPlan from "./project-plan.js";
import ProjectRunner from "./project-runner.js";
import ProjectSession, { AGENT_CONVERSATION_ID } from "./project-session.js";
import TaskHistory from "./task-history.js";
import WorkspaceManager from "./workspace.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const SSE_HEARTBEAT_INTERVAL_MS = 15 * 1_000;
const REMOTE_PASSWORD_MIN_LENGTH = 16;
const DASHBOARD_USERNAME = "agent";
const STATIC_ASSETS = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
    ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

function securityHeaders() {
    return {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
    };
}

function previewSecurityHeaders() {
    // The generated project's code is allowed to run only in a unique-origin
    // sandbox. This header applies even when someone opens the preview URL in
    // a separate tab, rather than only when the dashboard embeds it.
    // Deliberately omit X-Frame-Options: DENY here so the private dashboard
    // can show the sandboxed preview in its same-origin iframe.
    return {
        "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
    };
}

function responseJson(response, status, body) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders(),
    });
    response.end(JSON.stringify(body));
}

function responseProjectArtifactError(response, error) {
    responseJson(response, error?.status || 500, {
        error: error?.message || "The project artifact is unavailable.",
        code: error?.code || "PROJECT_ARTIFACT_FAILED",
    });
}

function responseEvent(response, name, body) {
    response.write(`event: ${name}\ndata: ${JSON.stringify(body)}\n\n`);
}

function keepSseAlive(response) {
    const heartbeat = setInterval(() => {
        if (response.writableEnded || response.destroyed) {
            clearInterval(heartbeat);
            return;
        }

        try {
            response.write(": keep-alive\n\n");
        } catch {
            clearInterval(heartbeat);
        }
    }, SSE_HEARTBEAT_INTERVAL_MS);

    heartbeat.unref?.();
    return () => clearInterval(heartbeat);
}

async function requestJson(request) {
    const chunks = [];
    let size = 0;

    for await (const chunk of request) {
        size += chunk.length;

        if (size > MAX_REQUEST_BYTES) {
            const error = new Error("Task requests must be smaller than 16 KB.");
            error.status = 413;
            throw error;
        }

        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        const error = new Error("Request body must be valid JSON.");
        error.status = 400;
        throw error;
    }
}

function isTaskFailure(result) {
    return result.startsWith("❌") || result.startsWith("Stopped after");
}

function publicEvent(message, details) {
    return {
        message,
        ok: details?.ok ?? true,
        tool: details?.tool ?? null,
        error: details?.error
            ? {
                code: details.error.code,
                message: details.error.message,
            }
            : null,
    };
}

function equalSecrets(value, expected) {
    const provided = Buffer.from(value, "utf8");
    const secret = Buffer.from(expected, "utf8");

    return provided.length === secret.length && timingSafeEqual(provided, secret);
}

function hasDashboardAccess(request, accessPassword) {
    if (!accessPassword) {
        return true;
    }

    const authorization = request.headers.authorization;

    if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) {
        return false;
    }

    let username = "";
    let password = "";

    try {
        const credentials = Buffer.from(authorization.slice(6), "base64").toString("utf8");
        const separator = credentials.indexOf(":");

        if (separator === -1) {
            return false;
        }

        username = credentials.slice(0, separator);
        password = credentials.slice(separator + 1);
    } catch {
        return false;
    }

    return equalSecrets(username, DASHBOARD_USERNAME) && equalSecrets(password, accessPassword);
}

function requestAuthentication(response) {
    response.writeHead(401, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "www-authenticate": 'Basic realm="My Coding Agent", charset="UTF-8"',
        ...securityHeaders(),
    });
    response.end("Authentication required.");
}

function isLoopbackHost(host) {
    return ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(
        String(host).trim().toLowerCase()
    );
}

function projectPreviewUnavailable() {
    return {
        state: "unavailable",
        project: null,
        url: null,
        message: "Project previews are available only in the local dashboard.",
    };
}

function configuredPort() {
    return Number(process.env.PORT || process.env.AGENT_UI_PORT || 3333);
}

function localUrl(host, port) {
    const formattedHost = host.includes(":") ? `[${host}]` : host;
    return `http://${formattedHost}:${port}`;
}

function workspaceIsReady(workspaceManager) {
    try {
        const projectsRoot = workspaceManager.resolveProjectsRoot({ create: true });
        accessSync(projectsRoot, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function activeTaskStatus(activeTask) {
    if (!activeTask) {
        return { state: "idle", taskId: null };
    }

    return {
        state: activeTask.controller.signal.aborted ? "cancelling" : "working",
        taskId: activeTask.id,
    };
}

export function createUiServer({
    agentRoot = process.cwd(),
    createModel = (profile) => new Nemotron({ model: profile.id }),
    modelHealth = new ModelHealth({ listModels: listNvidiaModels }),
    accessPassword = "",
    allowProjectPreviews = true,
    githubPublisher,
} = {}) {
    const workspaceManager = new WorkspaceManager({ agentRoot });
    const evaluationSuite = new EvaluationSuite();
    const projectArtifacts = new ProjectArtifacts(workspaceManager);
    const publisher = githubPublisher || new GitHubPublisher({ projectArtifacts });
    const projectEvaluator = new ProjectEvaluator(workspaceManager);
    const projectBrief = new ProjectBrief({ workspaceManager });
    const projectPlan = new ProjectPlan({ workspaceManager });
    const projectRunner = new ProjectRunner(workspaceManager);
    const projectSession = new ProjectSession({ workspaceManager });
    const taskHistory = new TaskHistory({ workspaceManager });
    const unavailableProfiles = new Map();
    let activeTask = null;
    let evaluationRun = null;
    let evaluationRunMode = null;
    let taskSequence = 0;

    const server = createServer(async (request, response) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");

        // Railway uses this unauthenticated endpoint only to confirm that the
        // container has started and can use its mounted project storage. It
        // intentionally exposes no workspace, project, model, or account data.
        if (request.method === "GET" && url.pathname === "/health") {
            const ready = workspaceIsReady(workspaceManager);
            responseJson(response, ready ? 200 : 503, {
                status: ready ? "ok" : "unavailable",
            });
            return;
        }

        if (!hasDashboardAccess(request, accessPassword)) {
            requestAuthentication(response);
            return;
        }

        // A page reload cannot resume the original SSE response, but it can
        // safely discover whether this server is still processing a task.
        // Keep this deliberately small: it does not expose the task prompt,
        // model, workspace, or streamed output.
        if (request.method === "GET" && url.pathname === "/api/tasks/active") {
            responseJson(response, 200, activeTaskStatus(activeTask));
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/tasks/history") {
            try {
                responseJson(response, 200, {
                    state: "ready",
                    records: taskHistory.recent(),
                    message: "Recent task outcomes are saved locally. Task prompts and model responses are not stored.",
                });
            } catch {
                responseJson(response, 200, {
                    state: "unavailable",
                    records: [],
                    message: "Local task history is temporarily unavailable.",
                });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/github") {
            responseJson(response, 200, publisher.status());
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/github/publish") {
            if (activeTask || evaluationRun) {
                responseJson(response, 409, {
                    error: "Wait for the active task or evaluation to finish before publishing source.",
                });
                return;
            }

            let body;

            try {
                body = await requestJson(request);
            } catch (error) {
                responseJson(response, error.status || 400, { error: error.message });
                return;
            }

            try {
                responseJson(response, 200, await publisher.publish({
                    confirmation: typeof body?.confirmation === "string" ? body.confirmation : "",
                }));
            } catch (error) {
                responseJson(response, error.status || 500, {
                    error: error.message || "GitHub publishing could not finish.",
                    code: error.code || "GITHUB_PUBLISH_FAILED",
                });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/models/health") {
            try {
                responseJson(response, 200, await modelHealth.check());
            } catch {
                responseJson(response, 200, {
                    status: "unknown",
                    models: [],
                    error: "Model availability could not be checked.",
                });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/context") {
            responseJson(response, 200, workspaceManager.getContext());
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/projects/evaluation") {
            try {
                responseJson(response, 200, projectEvaluator.evaluate());
            } catch {
                responseJson(response, 200, {
                    state: "unavailable",
                    project: null,
                    score: 0,
                    message: "Project readiness checks are temporarily unavailable.",
                    checks: [],
                });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/projects/plan") {
            if (!workspaceManager.getContext().project) {
                responseJson(response, 200, {
                    state: "idle",
                    project: null,
                    goal: null,
                    progress: { completed: 0, total: 0 },
                    milestones: [],
                    message: "Select a project to see its saved milestone plan.",
                });
                return;
            }

            try {
                responseJson(response, 200, projectPlan.read());
            } catch {
                responseJson(response, 200, {
                    state: "unavailable",
                    project: workspaceManager.getContext().project,
                    goal: null,
                    progress: { completed: 0, total: 0 },
                    milestones: [],
                    message: "Project plan metadata is temporarily unavailable.",
                });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/projects/brief") {
            try {
                responseJson(response, 200, projectBrief.read());
            } catch {
                responseJson(response, 200, {
                    state: "unavailable",
                    project: workspaceManager.getContext().project,
                    goal: null,
                    plan: null,
                    outcome: null,
                    updatedAt: null,
                    message: "Smart mode project brief is temporarily unavailable.",
                });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/conversation") {
            try {
                const turns = projectSession.recent(AGENT_CONVERSATION_ID);
                responseJson(response, 200, {
                    state: "ready",
                    turns,
                    message: turns.length > 0
                        ? "Saved agent conversation is available to follow-up tasks."
                        : "Your tasks and final agent responses will appear here.",
                });
            } catch {
                responseJson(response, 200, {
                    state: "unavailable",
                    turns: [],
                    message: "Agent conversation history is temporarily unavailable.",
                });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/conversation/clear") {
            if (activeTask) {
                responseJson(response, 409, {
                    error: "Wait for the active task to finish before clearing the conversation.",
                });
                return;
            }

            try {
                projectSession.clear(AGENT_CONVERSATION_ID);
                responseJson(response, 200, {
                    state: "cleared",
                    turns: [],
                    message: "Saved agent conversation cleared.",
                });
            } catch {
                responseJson(response, 500, {
                    error: "Agent conversation history could not be cleared.",
                });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/evaluations") {
            responseJson(response, 200, evaluationRun
                ? {
                    state: "running",
                    mode: evaluationRunMode || "deterministic",
                    total: evaluationSuite.scenarios.length,
                    passed: null,
                    passRate: null,
                    completedAt: null,
                    results: [],
                    message: "Running local baseline checks in isolated temporary workspaces.",
                }
                : evaluationSuite.status());
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/evaluations/run") {
            let body;

            try {
                body = await requestJson(request);
            } catch (error) {
                responseJson(response, error.status || 400, { error: error.message });
                return;
            }

            const evaluationMode = typeof body?.mode === "string" ? body.mode : "deterministic";
            const modelMode = typeof body?.modelMode === "string" ? body.modelMode : "auto";

            if (!["deterministic", "live"].includes(evaluationMode)) {
                responseJson(response, 400, { error: "Choose a supported evaluation mode." });
                return;
            }

            if (evaluationMode === "live" && (
                !MODEL_MODES.has(modelMode) ||
                (modelMode === "custom" && !process.env.NVIDIA_MODEL)
            )) {
                responseJson(response, 400, { error: "Choose a supported model mode for the live evaluation." });
                return;
            }

            if (evaluationMode === "live" && activeTask) {
                responseJson(response, 409, {
                    error: "Wait for the active task to finish before running a live model evaluation.",
                });
                return;
            }

            if (evaluationRun) {
                responseJson(response, 409, {
                    error: "The evaluation suite is already running.",
                });
                return;
            }

            evaluationRunMode = evaluationMode;
            evaluationRun = evaluationSuite.run({
                mode: evaluationMode,
                createAgentModel: evaluationMode === "live"
                    ? () => new ModelRouter({
                        mode: modelMode,
                        createModel,
                        unavailableProfiles,
                    })
                    : undefined,
            });

            try {
                responseJson(response, 200, await evaluationRun);
            } catch {
                responseJson(response, 500, {
                    error: "The evaluation suite could not finish.",
                });
            } finally {
                evaluationRun = null;
                evaluationRunMode = null;
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/projects/preview") {
            try {
                responseJson(response, 200, projectArtifacts.previewStatus());
            } catch (error) {
                responseProjectArtifactError(response, error);
            }
            return;
        }

        if (
            request.method === "GET" &&
            url.pathname.startsWith("/api/projects/preview/")
        ) {
            try {
                const encodedPath = url.pathname.slice("/api/projects/preview/".length);
                const preview = projectArtifacts.readPreviewFile(encodedPath);
                response.writeHead(200, {
                    "content-type": preview.contentType,
                    "content-length": preview.contents.length,
                    "cache-control": "no-store",
                    ...previewSecurityHeaders(),
                });
                response.end(preview.contents);
            } catch (error) {
                responseProjectArtifactError(response, error);
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/projects/download") {
            try {
                const archive = projectArtifacts.createSourceArchive();
                response.writeHead(200, {
                    "content-type": "application/gzip",
                    "content-length": archive.contents.length,
                    "content-disposition": `attachment; filename="${archive.filename}"`,
                    "cache-control": "no-store",
                    ...securityHeaders(),
                });
                response.end(archive.contents);
            } catch (error) {
                responseProjectArtifactError(response, error);
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/projects/run") {
            responseJson(
                response,
                200,
                allowProjectPreviews ? projectRunner.status() : projectPreviewUnavailable()
            );
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/projects/select") {
            // The agent and dashboard share one active workspace. Changing it
            // from a second dashboard action while a task is running could
            // send the remaining tool calls to the wrong generated project.
            if (activeTask) {
                responseJson(response, 409, {
                    error: "Wait for the active task to finish before changing projects.",
                    code: "ACTIVE_TASK_WORKSPACE_LOCKED",
                });
                return;
            }

            try {
                const body = await requestJson(request);
                const name = typeof body?.name === "string" ? body.name : "";
                workspaceManager.selectProject(name);
                responseJson(response, 200, workspaceManager.getContext());
            } catch (error) {
                responseJson(response, 400, {
                    error: error.message || "The project could not be selected.",
                    code: error.code || "PROJECT_SELECTION_FAILED",
                });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/projects/delete") {
            if (activeTask) {
                responseJson(response, 409, {
                    error: "Wait for the active task to finish before deleting a project.",
                    code: "ACTIVE_TASK_WORKSPACE_LOCKED",
                });
                return;
            }

            try {
                const body = await requestJson(request);
                const name = typeof body?.name === "string" ? body.name : "";
                const confirmation = typeof body?.confirmation === "string" ? body.confirmation : "";
                const activeProject = workspaceManager.getContext().project;

                if (!activeProject || name !== activeProject) {
                    const error = new Error("Select the project before deleting it.");
                    error.code = "PROJECT_DELETE_NOT_ACTIVE";
                    throw error;
                }

                if (confirmation !== name) {
                    const error = new Error("Type the full project name to confirm deletion.");
                    error.code = "PROJECT_DELETE_NOT_CONFIRMED";
                    throw error;
                }

                const runner = projectRunner.status();

                if (runner.project === activeProject) {
                    await projectRunner.stop();
                }

                responseJson(response, 200, workspaceManager.deleteProject(name));
            } catch (error) {
                responseJson(response, 400, {
                    error: error.message || "The project could not be deleted.",
                    code: error.code || "PROJECT_DELETE_FAILED",
                });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/projects/run") {
            if (!allowProjectPreviews) {
                responseJson(response, 403, {
                    error: "Project previews are available only in the local dashboard.",
                    code: "PROJECT_PREVIEW_LOCAL_ONLY",
                });
                return;
            }

            try {
                responseJson(response, 200, await projectRunner.run());
            } catch (error) {
                responseJson(response, 400, {
                    error: error.message || "The project could not start.",
                    code: error.code || "PROJECT_START_FAILED",
                });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/projects/stop") {
            if (!allowProjectPreviews) {
                responseJson(response, 403, {
                    error: "Project previews are available only in the local dashboard.",
                    code: "PROJECT_PREVIEW_LOCAL_ONLY",
                });
                return;
            }

            responseJson(response, 200, await projectRunner.stop());
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/tasks/cancel") {
            let body;

            try {
                body = await requestJson(request);
            } catch (error) {
                responseJson(response, error.status || 400, { error: error.message });
                return;
            }

            const taskId = typeof body?.taskId === "string" ? body.taskId : "";

            if (!activeTask) {
                responseJson(response, 409, { error: "There is no active task to cancel." });
                return;
            }

            if (taskId !== activeTask.id) {
                responseJson(response, 409, { error: "That task is no longer active." });
                return;
            }

            if (!activeTask.controller.signal.aborted) {
                activeTask.controller.abort(new Error("Task cancelled by user."));
            }

            responseJson(response, 202, { state: "cancelling", taskId });
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/tasks") {
            let body;

            try {
                body = await requestJson(request);
            } catch (error) {
                responseJson(response, error.status || 400, { error: error.message });
                return;
            }

            const task = typeof body?.task === "string" ? body.task.trim() : "";
            const mode = typeof body?.mode === "string" ? body.mode : "auto";

            if (!task) {
                responseJson(response, 400, { error: "Describe a task before running it." });
                return;
            }

            if (!MODEL_MODES.has(mode) || (mode === "custom" && !process.env.NVIDIA_MODEL)) {
                responseJson(response, 400, { error: "Choose a supported model mode." });
                return;
            }

            if (activeTask) {
                responseJson(response, 409, {
                    error: "The agent is already working on a task. Wait for it to finish before starting another.",
                });
                return;
            }

            const taskRecord = {
                id: `task-${++taskSequence}`,
                controller: new AbortController(),
                startedAt: Date.now(),
            };
            activeTask = taskRecord;
            response.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
                "x-accel-buffering": "no",
                "x-task-id": taskRecord.id,
                ...securityHeaders(),
            });
            responseEvent(response, "ready", { message: "The agent is working." });
            const stopHeartbeat = keepSseAlive(response);

            const model = new ModelRouter({
                mode,
                createModel,
                unavailableProfiles,
                onRoute: ({ profile, fallback, error }) => {
                    responseEvent(response, "model", {
                        label: profile.label,
                        summary: profile.summary,
                        fallback,
                        error,
                    });
                },
            });
            const agent = new Agent(model, {
                workspaceManager,
                projectBrief,
                onEvent: ({ message, details }) => {
                    responseEvent(response, "progress", publicEvent(message, details));
                },
            });

            let taskSucceeded = false;
            let taskResult = null;

            try {
                const result = await agent.run(task, {
                    signal: taskRecord.controller.signal,
                    sessionContext: projectSession.recent(AGENT_CONVERSATION_ID),
                });
                taskResult = result;
                taskSucceeded = !isTaskFailure(result);
                responseEvent(response, "result", {
                    ok: taskSucceeded,
                    result,
                    model: model.activeProfile?.label || null,
                    cancelled: taskRecord.controller.signal.aborted,
                });
            } catch (error) {
                taskResult = `❌ The agent could not complete this task: ${error.message || String(error)}`;
                responseEvent(response, "result", {
                    ok: false,
                    result: taskResult,
                    cancelled: taskRecord.controller.signal.aborted,
                });
            } finally {
                try {
                    projectSession.record(
                        AGENT_CONVERSATION_ID,
                        { task, outcome: taskResult }
                    );
                } catch {
                    // Conversation storage is helpful for follow-ups but must
                    // not change an already-completed task result.
                }
                try {
                    taskHistory.record({
                        createdAt: new Date(taskRecord.startedAt).toISOString(),
                        project: workspaceManager.getContext().project,
                        model: model.activeProfile?.label || null,
                        ok: taskSucceeded,
                        cancelled: taskRecord.controller.signal.aborted,
                        durationMs: Date.now() - taskRecord.startedAt,
                    });
                } catch {
                    // Task history is a local convenience. Its failure must not
                    // change the task's result or expose filesystem details.
                }
                stopHeartbeat();
                if (activeTask === taskRecord) {
                    activeTask = null;
                }
                response.end();
            }

            return;
        }

        const asset = STATIC_ASSETS.get(url.pathname);

        if (request.method === "GET" && asset) {
            try {
                const fileUrl = new URL(`../public/${asset.file}`, import.meta.url);
                const contents = await readFile(fileUrl);
                response.writeHead(200, {
                    "content-type": asset.type,
                    "cache-control": "no-cache",
                    "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'",
                    ...securityHeaders(),
                });
                response.end(contents);
            } catch {
                responseJson(response, 500, { error: "The local interface could not load." });
            }
            return;
        }

        responseJson(response, 404, { error: "Not found." });
    });

    server.on("close", () => {
        activeTask?.controller.abort(new Error("The local agent server stopped."));
        projectRunner.stop().catch(() => {});
    });

    return server;
}

export function startUiServer({
    port = configuredPort(),
    host = process.env.AGENT_UI_HOST || "127.0.0.1",
    accessPassword = process.env.AGENT_UI_PASSWORD || "",
} = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT or AGENT_UI_PORT must be an integer between 1 and 65535.");
    }

    if (!host || typeof host !== "string") {
        throw new Error("AGENT_UI_HOST must be a valid host name or IP address.");
    }

    if (typeof accessPassword !== "string") {
        throw new Error("AGENT_UI_PASSWORD must be a string.");
    }

    if (!isLoopbackHost(host) && accessPassword.length < REMOTE_PASSWORD_MIN_LENGTH) {
        throw new Error(
            `AGENT_UI_PASSWORD must be at least ${REMOTE_PASSWORD_MIN_LENGTH} characters when AGENT_UI_HOST is not local.`
        );
    }

    const isLocal = isLoopbackHost(host);
    const server = createUiServer({
        accessPassword,
        allowProjectPreviews: isLocal,
    });
    server.once("error", (error) => {
        console.error(`My Coding Agent UI could not start: ${error.message}`);
        process.exitCode = 1;
    });
    server.listen(port, host, () => {
        if (isLocal) {
            console.log(`My Coding Agent UI is ready at ${localUrl(host, port)}`);
            return;
        }

        console.log(
            `My Coding Agent UI is listening on ${host}:${port} with password protection enabled.`
        );
    });

    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    startUiServer();
}
