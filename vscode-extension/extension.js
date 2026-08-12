"use strict";

const crypto = require("node:crypto");
const vscode = require("vscode");
const {
    DEFAULT_DASHBOARD_URL,
    cancelTask,
    getContext,
    normalizeDashboardUrl,
    selectProject,
    streamTask,
} = require("./dashboard-client.js");

const SECRET_KEY = "satyamsAgent.dashboardAccessPassword";
const MODEL_MODES = [
    ["auto", "Auto"],
    ["smart", "Smart"],
    ["nano", "Nano"],
    ["oss", "GPT-OSS 20B"],
    ["llama", "Llama 3.3 70B"],
    ["kimi", "Kimi K2.6"],
    ["oss120", "GPT-OSS 120B"],
    ["ultra", "Nemotron Ultra"],
    ["glm", "GLM-5.2"],
    ["custom", "Fine-tuned"],
];

let panel;
let currentTask = null;

function configurationUrl() {
    return vscode.workspace.getConfiguration("satyamsAgent")
        .get("dashboardUrl", DEFAULT_DASHBOARD_URL);
}

function activePanel() {
    return panel || null;
}

function sendToPanel(message) {
    if (!panel) {
        return;
    }

    panel.webview.postMessage(message).catch(() => {
        // A webview can close while a task stream is completing. The task
        // remains safely managed by the dashboard in that case.
    });
}

function panelContext(context) {
    return {
        project: context?.project || null,
        projects: Array.isArray(context?.projects) ? context.projects : [],
    };
}

async function connectionDetails(extensionContext) {
    return {
        baseUrl: normalizeDashboardUrl(configurationUrl()),
        accessPassword: await extensionContext.secrets.get(SECRET_KEY),
    };
}

async function refreshContext(extensionContext, { showError = false } = {}) {
    try {
        const { baseUrl, accessPassword } = await connectionDetails(extensionContext);
        const context = await getContext(baseUrl, { accessPassword });
        sendToPanel({ type: "context", context: panelContext(context) });
        return context;
    } catch (error) {
        sendToPanel({ type: "connectionError", message: error.message });
        if (showError) {
            vscode.window.showErrorMessage(`Satyam's Agent: ${error.message}`);
        }
        return null;
    }
}

async function chooseProject(extensionContext) {
    const context = await refreshContext(extensionContext, { showError: true });
    const projects = Array.isArray(context?.projects) ? context.projects : [];

    if (projects.length === 0) {
        vscode.window.showInformationMessage("Satyam's Agent: no projects are available yet.");
        return;
    }

    const selected = await vscode.window.showQuickPick(
        projects.map((name) => ({
            label: name,
            description: name === context.project ? "Current project" : "",
        })),
        { placeHolder: "Choose the project the agent should work on" }
    );

    if (!selected) {
        return;
    }

    try {
        const { baseUrl, accessPassword } = await connectionDetails(extensionContext);
        const updated = await selectProject(baseUrl, selected.label, { accessPassword });
        sendToPanel({ type: "context", context: panelContext(updated) });
        vscode.window.showInformationMessage(`Satyam's Agent: selected ${updated.project}.`);
    } catch (error) {
        vscode.window.showErrorMessage(`Satyam's Agent: ${error.message}`);
    }
}

async function setAccessPassword(extensionContext) {
    const value = await vscode.window.showInputBox({
        prompt: "Dashboard password (leave blank to remove the saved password)",
        password: true,
        ignoreFocusOut: true,
    });

    if (value === undefined) {
        return;
    }

    if (value) {
        await extensionContext.secrets.store(SECRET_KEY, value);
        vscode.window.showInformationMessage("Satyam's Agent: dashboard password saved securely.");
    } else {
        await extensionContext.secrets.delete(SECRET_KEY);
        vscode.window.showInformationMessage("Satyam's Agent: saved dashboard password removed.");
    }

    await refreshContext(extensionContext);
}

function taskMessage(event) {
    const details = event?.data || {};

    if (event?.event === "progress") {
        return details.message || "The agent completed a step.";
    }

    if (event?.event === "model") {
        return details.label ? `Using ${details.label}` : "Selecting a model";
    }

    if (event?.event === "result") {
        return details.result || "The task finished.";
    }

    return details.message || "Dashboard update received.";
}

async function runTask(extensionContext, request) {
    if (currentTask) {
        vscode.window.showWarningMessage("Satyam's Agent: a task is already running.");
        return;
    }

    const task = typeof request?.task === "string" ? request.task.trim() : "";
    const mode = MODEL_MODES.some(([value]) => value === request?.mode) ? request.mode : "auto";

    if (!task) {
        sendToPanel({ type: "taskError", message: "Describe a task before running it." });
        return;
    }

    const controller = new AbortController();
    currentTask = { controller, taskId: null };
    sendToPanel({ type: "taskState", state: "working" });

    try {
        const { baseUrl, accessPassword } = await connectionDetails(extensionContext);
        await streamTask(baseUrl, {
            task,
            mode,
            accessPassword,
            signal: controller.signal,
            onTaskId(taskId) {
                if (currentTask) {
                    currentTask.taskId = taskId;
                }
            },
            onEvent(event) {
                sendToPanel({
                    type: "taskEvent",
                    event: event.event,
                    message: taskMessage(event),
                    result: event.event === "result" ? event.data?.result || "" : "",
                    ok: event.data?.ok,
                });
            },
        });
    } catch (error) {
        const aborted = controller.signal.aborted;
        sendToPanel({
            type: "taskError",
            message: aborted ? "Task stream closed." : error.message,
        });
    } finally {
        currentTask = null;
        sendToPanel({ type: "taskState", state: "idle" });
        await refreshContext(extensionContext);
    }
}

async function cancelCurrentTask(extensionContext) {
    if (!currentTask) {
        vscode.window.showInformationMessage("Satyam's Agent: there is no task running in this panel.");
        return;
    }

    const task = currentTask;

    try {
        const { baseUrl, accessPassword } = await connectionDetails(extensionContext);

        if (task.taskId) {
            await cancelTask(baseUrl, task.taskId, { accessPassword });
            sendToPanel({ type: "taskNotice", message: "Cancelling the dashboard task…" });
        } else {
            task.controller.abort();
            sendToPanel({
                type: "taskNotice",
                message: "The task connection was closed before the dashboard assigned an ID.",
            });
        }
    } catch (error) {
        sendToPanel({ type: "taskError", message: error.message });
        vscode.window.showErrorMessage(`Satyam's Agent: ${error.message}`);
    }
}

function createPanel(extensionContext) {
    panel = vscode.window.createWebviewPanel(
        "satyamsAgent.panel",
        "Satyam's Agent",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = webviewHtml(panel.webview);

    panel.onDidDispose(() => {
        panel = undefined;
    }, null, extensionContext.subscriptions);

    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message?.type) {
        case "ready":
            await refreshContext(extensionContext);
            break;
        case "runTask":
            await runTask(extensionContext, message);
            break;
        case "cancelTask":
            await cancelCurrentTask(extensionContext);
            break;
        case "selectProject":
            await chooseProject(extensionContext);
            break;
        case "openDashboard":
            await openDashboard();
            break;
        default:
            break;
        }
    }, null, extensionContext.subscriptions);

    return panel;
}

async function openDashboard() {
    try {
        await vscode.env.openExternal(vscode.Uri.parse(normalizeDashboardUrl(configurationUrl())));
    } catch (error) {
        vscode.window.showErrorMessage(`Satyam's Agent: ${error.message}`);
    }
}

function openPanel(extensionContext) {
    const existing = activePanel();

    if (existing) {
        existing.reveal(vscode.ViewColumn.Beside);
        refreshContext(extensionContext);
        return;
    }

    createPanel(extensionContext);
}

function webviewHtml(webview) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const modeOptions = MODEL_MODES.map(([value, label]) =>
        `<option value="${value}">${label}</option>`
    ).join("");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Satyam's Agent</title>
  <style>
    :root { color-scheme: dark; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    body { margin: 0; padding: 18px; background: var(--vscode-editor-background); }
    main { max-width: 760px; margin: 0 auto; display: grid; gap: 16px; }
    .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); border-radius: 10px; padding: 16px; }
    h1, h2, p { margin: 0; } h1 { font-size: 1.25rem; } h2 { font-size: .95rem; }
    .muted { color: var(--vscode-descriptionForeground); font-size: .88rem; line-height: 1.45; }
    .heading, .row { display: flex; align-items: center; gap: 10px; justify-content: space-between; flex-wrap: wrap; }
    textarea, select { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 10px; font: inherit; }
    textarea { min-height: 125px; resize: vertical; line-height: 1.45; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 5px; padding: 8px 12px; font: inherit; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); } button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { cursor: not-allowed; opacity: .6; } .hidden { display: none; }
    #status { color: var(--vscode-descriptionForeground); min-height: 1.2em; }
    #events { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 8px; max-height: 290px; overflow: auto; }
    #events li { border-left: 3px solid var(--vscode-focusBorder); padding: 7px 9px; background: var(--vscode-textBlockQuote-background); line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
    #result { margin-top: 12px; padding: 10px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="heading"><h1>Satyam's Agent</h1><button id="open-dashboard" class="secondary" type="button">Open dashboard</button></div>
      <p class="muted" style="margin-top:8px">Your local coding agent, connected to the same dashboard project and saved conversation.</p>
    </section>
    <section class="card">
      <div class="heading"><h2>Workspace</h2><button id="select-project" class="secondary" type="button">Select project</button></div>
      <p id="project" class="muted" style="margin-top:8px">Connecting to the dashboard…</p>
    </section>
    <section class="card">
      <form id="task-form">
        <label for="task"><h2>Give the agent a task</h2></label>
        <textarea id="task" maxlength="12000" placeholder="Example: Inspect the selected app and improve its empty state UI."></textarea>
        <div class="row" style="margin-top:10px"><label class="muted" for="mode">Model mode</label><select id="mode">${modeOptions}</select></div>
        <div class="row" style="margin-top:12px"><span id="status" aria-live="polite">Ready.</span><span><button id="cancel" class="secondary hidden" type="button">Cancel task</button> <button id="run" type="submit">Run task</button></span></div>
      </form>
      <div id="result" class="hidden" aria-live="polite"></div>
      <ul id="events" aria-live="polite"></ul>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const task = document.querySelector("#task");
    const mode = document.querySelector("#mode");
    const form = document.querySelector("#task-form");
    const run = document.querySelector("#run");
    const cancel = document.querySelector("#cancel");
    const status = document.querySelector("#status");
    const project = document.querySelector("#project");
    const events = document.querySelector("#events");
    const result = document.querySelector("#result");
    const saved = vscode.getState() || {};
    if (typeof saved.mode === "string") mode.value = saved.mode;
    function setState(working) { run.disabled = working; task.disabled = working; mode.disabled = working; cancel.classList.toggle("hidden", !working); }
    function addEvent(message) { const item = document.createElement("li"); item.textContent = message; events.prepend(item); while (events.children.length > 40) events.lastElementChild.remove(); }
    function setProject(context) { const active = context && context.project; const total = Array.isArray(context && context.projects) ? context.projects.length : 0; project.textContent = active ? 'Active project: ' + active + ' (' + total + ' available)' : 'No project selected (' + total + ' available).'; }
    form.addEventListener("submit", (event) => { event.preventDefault(); result.classList.add("hidden"); result.textContent = ""; events.replaceChildren(); vscode.setState({ mode: mode.value }); vscode.postMessage({ type: "runTask", task: task.value, mode: mode.value }); });
    cancel.addEventListener("click", () => vscode.postMessage({ type: "cancelTask" }));
    document.querySelector("#select-project").addEventListener("click", () => vscode.postMessage({ type: "selectProject" }));
    document.querySelector("#open-dashboard").addEventListener("click", () => vscode.postMessage({ type: "openDashboard" }));
    window.addEventListener("message", (event) => { const message = event.data || {}; if (message.type === "context") setProject(message.context); if (message.type === "connectionError" || message.type === "taskError") { status.textContent = message.message; addEvent(message.message); } if (message.type === "taskNotice") { status.textContent = message.message; } if (message.type === "taskState") { const working = message.state === "working"; setState(working); status.textContent = working ? "The agent is working…" : "Ready."; } if (message.type === "taskEvent") { addEvent(message.message); if (message.event === "result") { result.textContent = message.result; result.classList.remove("hidden"); status.textContent = message.ok === false ? "Task finished with an issue." : "Task complete."; } } });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

function activate(extensionContext) {
    extensionContext.subscriptions.push(
        vscode.commands.registerCommand("satyamsAgent.openPanel", () => openPanel(extensionContext)),
        vscode.commands.registerCommand("satyamsAgent.openDashboard", openDashboard),
        vscode.commands.registerCommand("satyamsAgent.selectProject", () => chooseProject(extensionContext)),
        vscode.commands.registerCommand("satyamsAgent.setAccessPassword", () => setAccessPassword(extensionContext))
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
