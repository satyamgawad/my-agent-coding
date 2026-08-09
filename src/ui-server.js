import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Agent from "./agent.js";
import ModelRouter, { MODEL_MODES } from "./model-router.js";
import Nemotron from "./nemotron.js";
import ProjectRunner from "./project-runner.js";
import WorkspaceManager from "./workspace.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const STATIC_ASSETS = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
    ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

function responseJson(response, status, body) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
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

export function createUiServer({
    agentRoot = process.cwd(),
    createModel = (profile) => new Nemotron({ model: profile.id }),
} = {}) {
    const workspaceManager = new WorkspaceManager({ agentRoot });
    const projectRunner = new ProjectRunner(workspaceManager);
    let runningTask = false;

    const server = createServer(async (request, response) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");

        if (request.method === "GET" && url.pathname === "/api/context") {
            responseJson(response, 200, workspaceManager.getContext());
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/projects/run") {
            responseJson(response, 200, projectRunner.status());
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
            responseJson(response, 200, await projectRunner.stop());
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

            if (runningTask) {
                responseJson(response, 409, {
                    error: "The agent is already working on a task. Wait for it to finish before starting another.",
                });
                return;
            }

            runningTask = true;
            response.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
                "x-accel-buffering": "no",
            });
            responseEvent(response, "ready", { message: "The agent is working." });

            const model = new ModelRouter({
                mode,
                createModel,
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
                const result = await agent.run(task);
                responseEvent(response, "result", {
                    ok: !isTaskFailure(result),
                    result,
                    model: model.activeProfile?.label || null,
                });
            } catch (error) {
                responseEvent(response, "result", {
                    ok: false,
                    result: `❌ The agent could not complete this task: ${error.message || String(error)}`,
                });
            } finally {
                runningTask = false;
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
                    "x-content-type-options": "nosniff",
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
        projectRunner.stop().catch(() => {});
    });

    return server;
}

export function startUiServer({ port = Number(process.env.AGENT_UI_PORT || 3333) } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("AGENT_UI_PORT must be an integer between 1 and 65535.");
    }

    const server = createUiServer();
    server.once("error", (error) => {
        console.error(`My Coding Agent UI could not start: ${error.message}`);
        process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () => {
        console.log(`My Coding Agent UI is ready at http://127.0.0.1:${port}`);
    });

    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    startUiServer();
}
