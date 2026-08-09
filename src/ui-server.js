import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Agent from "./agent.js";
import ModelHealth from "./model-health.js";
import ModelRouter, { MODEL_MODES } from "./model-router.js";
import Nemotron, { listNvidiaModels } from "./nemotron.js";
import ProjectRunner from "./project-runner.js";
import WorkspaceManager from "./workspace.js";

const MAX_REQUEST_BYTES = 16 * 1024;
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

function responseJson(response, status, body) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders(),
    });
    response.end(JSON.stringify(body));
}

function responseEvent(response, name, body) {
    response.write(`event: ${name}\ndata: ${JSON.stringify(body)}\n\n`);
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

export function createUiServer({
    agentRoot = process.cwd(),
    createModel = (profile) => new Nemotron({ model: profile.id }),
    modelHealth = new ModelHealth({ listModels: listNvidiaModels }),
    accessPassword = "",
    allowProjectPreviews = true,
} = {}) {
    const workspaceManager = new WorkspaceManager({ agentRoot });
    const projectRunner = new ProjectRunner(workspaceManager);
    const unavailableProfiles = new Map();
    let activeTask = null;
    let taskSequence = 0;

    const server = createServer(async (request, response) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");

        if (!hasDashboardAccess(request, accessPassword)) {
            requestAuthentication(response);
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

        if (request.method === "GET" && url.pathname === "/api/projects/run") {
            responseJson(
                response,
                200,
                allowProjectPreviews ? projectRunner.status() : projectPreviewUnavailable()
            );
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/projects/select") {
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

            if (!MODEL_MODES.has(mode) || mode === "custom") {
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
                onEvent: ({ message, details }) => {
                    responseEvent(response, "progress", publicEvent(message, details));
                },
            });

            try {
                const result = await agent.run(task, { signal: taskRecord.controller.signal });
                responseEvent(response, "result", {
                    ok: !isTaskFailure(result),
                    result,
                    model: model.activeProfile?.label || null,
                    cancelled: taskRecord.controller.signal.aborted,
                });
            } catch (error) {
                responseEvent(response, "result", {
                    ok: false,
                    result: `❌ The agent could not complete this task: ${error.message || String(error)}`,
                    cancelled: taskRecord.controller.signal.aborted,
                });
            } finally {
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
