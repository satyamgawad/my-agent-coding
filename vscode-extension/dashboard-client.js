"use strict";

const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:3333";

function clientError(message, code = "DASHBOARD_REQUEST_FAILED") {
    const error = new Error(message);
    error.code = code;
    return error;
}

function activeFetch(fetchImpl) {
    const selected = fetchImpl || globalThis.fetch;

    if (typeof selected !== "function") {
        throw clientError("This VS Code runtime does not support dashboard requests.", "FETCH_UNAVAILABLE");
    }

    return selected;
}

function parseResponseText(text) {
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function dashboardError(response, body) {
    const message = typeof body?.error === "string" && body.error.trim()
        ? body.error.trim()
        : `The dashboard request failed (${response.status}).`;
    return clientError(message, "DASHBOARD_RESPONSE_ERROR");
}

function authorizationHeader(accessPassword) {
    if (typeof accessPassword !== "string" || !accessPassword) {
        return {};
    }

    return {
        authorization: `Basic ${Buffer.from(`agent:${accessPassword}`, "utf8").toString("base64")}`,
    };
}

function dashboardEndpoint(baseUrl, pathname) {
    if (typeof pathname !== "string" || !pathname.startsWith("/")) {
        throw clientError("Dashboard API paths must begin with /.", "INVALID_DASHBOARD_PATH");
    }

    return `${normalizeDashboardUrl(baseUrl)}${pathname}`;
}

function requestOptions({ method = "GET", body, accessPassword, signal } = {}) {
    const hasBody = body !== undefined;
    return {
        method,
        signal,
        headers: {
            accept: "application/json",
            ...authorizationHeader(accessPassword),
            ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
    };
}

function processSsePacket(packet, onEvent) {
    const lines = packet.split("\n");
    let event = "message";
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith("event:")) {
            event = line.slice("event:".length).trim() || "message";
        } else if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trimStart());
        }
    }

    if (dataLines.length === 0) {
        return;
    }

    const rawData = dataLines.join("\n");
    const data = parseResponseText(rawData);

    if (data !== null) {
        onEvent({ event, data });
    }
}

async function readSse(responseBody, onEvent) {
    if (!responseBody || typeof responseBody.getReader !== "function") {
        throw clientError("The dashboard did not provide a task event stream.", "INVALID_TASK_STREAM");
    }

    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    while (true) {
        const { value, done } = await reader.read();
        buffered += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");

        let boundary;
        while ((boundary = buffered.indexOf("\n\n")) !== -1) {
            processSsePacket(buffered.slice(0, boundary), onEvent);
            buffered = buffered.slice(boundary + 2);
        }

        if (done) {
            break;
        }
    }

    if (buffered.trim()) {
        processSsePacket(buffered, onEvent);
    }
}

function normalizeDashboardUrl(value = DEFAULT_DASHBOARD_URL) {
    if (typeof value !== "string" || !value.trim()) {
        throw clientError("Set a dashboard URL before connecting.", "INVALID_DASHBOARD_URL");
    }

    let parsed;

    try {
        parsed = new URL(value.trim());
    } catch {
        throw clientError("Dashboard URL must be a valid http or https URL.", "INVALID_DASHBOARD_URL");
    }

    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw clientError("Dashboard URL must be an http or https base URL without credentials, query text, or a fragment.", "INVALID_DASHBOARD_URL");
    }

    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
}

async function requestJson(baseUrl, pathname, options = {}) {
    const response = await activeFetch(options.fetchImpl)(
        dashboardEndpoint(baseUrl, pathname),
        requestOptions(options)
    );
    const body = parseResponseText(await response.text());

    if (!response.ok) {
        throw dashboardError(response, body);
    }

    return body;
}

async function streamTask(baseUrl, { task, mode = "auto", accessPassword, onEvent, onTaskId, signal, fetchImpl } = {}) {
    if (typeof task !== "string" || !task.trim()) {
        throw clientError("Describe a task before running it.", "INVALID_TASK");
    }

    const response = await activeFetch(fetchImpl)(
        dashboardEndpoint(baseUrl, "/api/tasks"),
        {
            ...requestOptions({
                method: "POST",
                body: { task: task.trim(), mode },
                accessPassword,
                signal,
            }),
            headers: {
                ...authorizationHeader(accessPassword),
                accept: "text/event-stream",
                "content-type": "application/json",
            },
        }
    );

    if (!response.ok) {
        throw dashboardError(response, parseResponseText(await response.text()));
    }

    onTaskId?.(response.headers.get("x-task-id"));
    await readSse(response.body, typeof onEvent === "function" ? onEvent : () => {});
}

function getContext(baseUrl, options = {}) {
    return requestJson(baseUrl, "/api/context", options);
}

function selectProject(baseUrl, name, options = {}) {
    return requestJson(baseUrl, "/api/projects/select", {
        ...options,
        method: "POST",
        body: { name },
    });
}

function cancelTask(baseUrl, taskId, options = {}) {
    return requestJson(baseUrl, "/api/tasks/cancel", {
        ...options,
        method: "POST",
        body: { taskId },
    });
}

module.exports = {
    DEFAULT_DASHBOARD_URL,
    cancelTask,
    getContext,
    normalizeDashboardUrl,
    readSse,
    selectProject,
    streamTask,
};
