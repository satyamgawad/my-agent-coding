const taskForm = document.querySelector("#task-form");
const taskInput = document.querySelector("#task-input");
const runButton = document.querySelector("#run-button");
const cancelButton = document.querySelector("#cancel-button");
const taskHint = document.querySelector("#task-hint");
const modelMode = document.querySelector("#model-mode");
const modelNote = document.querySelector("#model-note");
const modelHealth = document.querySelector("#model-health");
const connection = document.querySelector("#connection");
const activeProject = document.querySelector("#active-project strong");
const projectCount = document.querySelector("#project-count");
const projectList = document.querySelector("#project-list");
const runProjectButton = document.querySelector("#run-project");
const openProject = document.querySelector("#open-project");
const runnerStatus = document.querySelector("#runner-status");
const activityList = document.querySelector("#activity-list");
const activityState = document.querySelector("#activity-state");
const resultCard = document.querySelector(".result-card");
const resultTitle = document.querySelector("#result-title");
const resultText = document.querySelector("#result-text");
const resultMark = document.querySelector("#result-mark");

const toolLabels = {
  createProject: "Created a project",
  listProjects: "Listed projects",
  selectProject: "Selected a project",
  listFiles: "Listed files",
  projectTree: "Inspected the project structure",
  readFile: "Read a file",
  writeFile: "Wrote a file",
  editFile: "Updated a file",
  terminal: "Ran a development command",
  test: "Ran tests",
};

const modelNotes = {
  auto: "Auto starts fast for routine work and uses deeper lanes only when the task clearly needs them.",
  flash: "Start with the fastest coding and tool-use model, then keep stronger fallbacks ready.",
  ultra: "Start with the dependable NVIDIA coding model, with GLM and Flash available if needed.",
  glm: "Start with maximum depth for complex, long-horizon work, with fast recovery options.",
};

let workspaceContext = { project: null };
let projectStatus = { state: "idle", project: null, url: null };
let activeTaskId = null;
let taskStatusKnown = false;
let recoveringActiveTask = false;
let activeTaskPoll = null;

const ACTIVE_TASK_POLL_INTERVAL_MS = 2_500;

function setConnection(text, offline = false) {
  connection.lastElementChild.textContent = text;
  connection.firstElementChild.style.background = offline ? "var(--coral)" : "var(--aqua)";
}

function setRunning(isRunning) {
  runButton.disabled = isRunning || !taskStatusKnown;
  taskInput.disabled = isRunning || !taskStatusKnown;
  modelMode.disabled = isRunning || !taskStatusKnown;
  runButton.firstElementChild.textContent = isRunning ? "Working…" : "Run task";
  taskHint.textContent = isRunning
    ? "The agent is working through the task and streaming its verified steps."
    : taskStatusKnown
      ? "The agent verifies each change before it reports success."
      : "Checking whether an earlier task is still running…";
  activityState.textContent = isRunning ? "Working" : "Ready";
  activityState.classList.toggle("is-working", isRunning);
  cancelButton.hidden = !isRunning;
  cancelButton.disabled = !isRunning || !activeTaskId;

  if (!isRunning) {
    activeTaskId = null;
    cancelButton.textContent = "Cancel task";
  }
}

function stopActiveTaskPolling() {
  if (!activeTaskPoll) return;
  clearInterval(activeTaskPoll);
  activeTaskPoll = null;
}

function showRecoveredTask(status, { announce = false, replaceActivity = false } = {}) {
  const taskChanged = activeTaskId !== status.taskId;
  const shouldAnnounce = announce && (!recoveringActiveTask || taskChanged);

  activeTaskId = status.taskId;
  recoveringActiveTask = true;
  setRunning(true);

  if (status.state === "cancelling") {
    cancelButton.disabled = true;
    cancelButton.textContent = "Cancelling…";
    taskHint.textContent = "Cancelling the current task. Changes already completed will remain.";
  }

  resultTitle.textContent = status.state === "cancelling" ? "Cancelling task" : "Agent is working";
  resultMark.textContent = "…";
  resultText.textContent = "This task began before this dashboard connection. Its live trace cannot be replayed, but it is still running and can be cancelled.";
  resultCard.classList.remove("is-success", "is-error");

  if (shouldAnnounce) {
    if (replaceActivity) clearActivity();
    addActivity(
      status.state === "cancelling" ? "Task cancellation is still in progress" : "Recovered active task",
      "The agent is still working on a task started before this page loaded."
    );
  }
}

function showRecoveredTaskCompletion() {
  resultTitle.textContent = "Task finished";
  resultMark.textContent = "✓";
  resultText.textContent = "The task finished while this dashboard was disconnected. Review the active project for its completed changes.";
  resultCard.classList.remove("is-success", "is-error");
  addActivity("Recovered task finished", "Review the active project before starting another task.");
}

function startActiveTaskPolling() {
  if (activeTaskPoll) return;

  activeTaskPoll = setInterval(() => {
    refreshActiveTask({ announceCompletion: true });
  }, ACTIVE_TASK_POLL_INTERVAL_MS);
}

async function refreshActiveTask({ announce = false, replaceActivity = false, announceCompletion = false } = {}) {
  try {
    const response = await fetch("/api/tasks/active", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Task status is unavailable.");

    const status = await response.json();
    taskStatusKnown = true;

    if (
      !status ||
      !["idle", "working", "cancelling"].includes(status.state) ||
      (status.state !== "idle" && typeof status.taskId !== "string")
    ) {
      throw new Error("Task status is unavailable.");
    }

    if (status.state === "idle") {
      const hadRecoveredTask = recoveringActiveTask;
      activeTaskId = null;
      recoveringActiveTask = false;
      stopActiveTaskPolling();
      setRunning(false);

      if (hadRecoveredTask && announceCompletion) {
        showRecoveredTaskCompletion();
        refreshContext();
      }

      return false;
    }

    showRecoveredTask(status, { announce, replaceActivity });
    startActiveTaskPolling();
    return true;
  } catch {
    taskStatusKnown = true;
    if (!activeTaskId) setRunning(false);
    setConnection("Task status unavailable", true);
    return recoveringActiveTask && Boolean(activeTaskId);
  }
}

function clearActivity() {
  activityList.textContent = "";
}

function addActivity(title, description = "", kind = "") {
  const item = document.createElement("li");
  item.className = `activity-item${kind ? ` is-${kind}` : ""}`;

  const icon = document.createElement("span");
  icon.className = "activity-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = kind === "failed" ? "!" : kind === "user" ? "→" : "✓";

  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  copy.append(heading);

  if (description) {
    const detail = document.createElement("p");
    detail.textContent = description;
    copy.append(detail);
  }

  item.append(icon, copy);
  activityList.append(item);
  activityList.scrollTop = activityList.scrollHeight;
}

function showResult(text, ok) {
  resultCard.classList.toggle("is-success", ok);
  resultCard.classList.toggle("is-error", !ok);
  resultTitle.textContent = ok ? "Task complete" : "Task needs attention";
  resultMark.textContent = ok ? "✦" : "!";
  resultText.textContent = text;
}

function showRequestError(message, title = "Could not start the task") {
  addActivity(title, message, "failed");
  showResult(message, false);
}

function renderProjectRunner() {
  if (projectStatus.state === "unavailable") {
    runProjectButton.disabled = true;
    runProjectButton.textContent = "Local only";
    runProjectButton.removeAttribute("aria-busy");
    runnerStatus.textContent = projectStatus.message || "Project previews are available only in the local dashboard.";
    openProject.hidden = true;
    return;
  }

  const hasProject = Boolean(workspaceContext.project);
  const runningActiveProject = projectStatus.state === "running" && projectStatus.project === workspaceContext.project;
  const runningAnotherProject = projectStatus.state === "running" && !runningActiveProject;

  runProjectButton.disabled = !hasProject;
  runProjectButton.textContent = runningActiveProject ? "Stop project" : "Run project";
  runProjectButton.removeAttribute("aria-busy");

  if (!hasProject) {
    runnerStatus.textContent = "Select a project to run it locally.";
    openProject.hidden = true;
    return;
  }

  if (runningActiveProject) {
    runnerStatus.textContent = `${workspaceContext.project} is running locally.`;
    openProject.href = projectStatus.url;
    openProject.hidden = false;
    return;
  }

  if (runningAnotherProject) {
    runnerStatus.textContent = `${projectStatus.project} is running now. Starting ${workspaceContext.project} will replace that preview.`;
    openProject.href = projectStatus.url;
    openProject.hidden = false;
    return;
  }

  runnerStatus.textContent = `Run ${workspaceContext.project} in a local browser tab.`;
  openProject.hidden = true;
}

async function refreshProjectStatus() {
  const response = await fetch("/api/projects/run", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Project preview is unavailable.");
  projectStatus = await response.json();
  renderProjectRunner();
}

function renderModelHealth(health) {
  if (health.status === "unknown") {
    modelHealth.textContent = "Model status is temporarily unavailable. Tasks can still use automatic fallback.";
    modelHealth.className = "model-health is-unknown";
    return;
  }

  const unavailable = (health.models || []).filter((profile) => profile.available === false);
  if (health.status === "unavailable") {
    modelHealth.textContent = "None of the configured model routes are available right now. The agent will retry when one returns.";
    modelHealth.className = "model-health is-degraded";
    return;
  }

  if (unavailable.length === 0) {
    modelHealth.textContent = "All three model routes are available.";
    modelHealth.className = "model-health is-ready";
    return;
  }

  const labels = unavailable.map((profile) => profile.label).join(", ");
  modelHealth.textContent = `Fallback ready · unavailable: ${labels}.`;
  modelHealth.className = "model-health is-degraded";
}

async function refreshModelHealth() {
  try {
    const response = await fetch("/api/models/health", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Model health is unavailable.");
    renderModelHealth(await response.json());
  } catch {
    modelHealth.textContent = "Model status is temporarily unavailable. Tasks can still use automatic fallback.";
    modelHealth.className = "model-health is-unknown";
  }
}

async function refreshContext() {
  try {
    const response = await fetch("/api/context", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("The workspace is unavailable.");
    const context = await response.json();
    workspaceContext = context;
    const projects = context.projects || [];
    projectCount.textContent = `${projects.length} project${projects.length === 1 ? "" : "s"}`;
    activeProject.textContent = context.project || "No project selected";
    projectList.textContent = "";

    if (projects.length === 0) {
      const item = document.createElement("li");
      item.className = "empty-state";
      item.textContent = "Projects you create will appear here.";
      projectList.append(item);
    } else {
      for (const project of projects) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = project;
        button.classList.toggle("is-active", project === context.project);
        button.addEventListener("click", () => selectProject(project));
        item.append(button);
        projectList.append(item);
      }
    }

    await refreshProjectStatus();
  } catch {
    setConnection("Workspace offline", true);
  }
}

async function selectProject(name) {
  try {
    const response = await fetch("/api/projects/select", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The project could not be selected.");

    workspaceContext = body;
    await refreshContext();
    addActivity(`Selected ${name}`, "It is ready to run or receive a new task.");
  } catch (error) {
    showRequestError(error.message || "The project could not be selected.");
  }
}

async function toggleProjectRunner() {
  const isRunning = projectStatus.state === "running" && projectStatus.project === workspaceContext.project;
  runProjectButton.disabled = true;
  runProjectButton.setAttribute("aria-busy", "true");
  runProjectButton.textContent = isRunning ? "Stopping…" : "Starting…";
  runnerStatus.textContent = isRunning ? "Stopping the local preview…" : "Starting a local preview…";

  try {
    const response = await fetch(isRunning ? "/api/projects/stop" : "/api/projects/run", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The project could not be started.");

    projectStatus = body;
    renderProjectRunner();
    addActivity(
      isRunning ? "Stopped the project preview" : "Project preview is running",
      isRunning ? "The local app has stopped." : `Open ${body.url} to use it.`
    );
  } catch (error) {
    showRequestError(error.message || "The project preview could not be started.");
  } finally {
    renderProjectRunner();
  }
}

function handleProgress(event) {
  if (event.tool) {
    const label = toolLabels[event.tool] || event.tool;
    addActivity(label, event.error?.message || "Verified by the local workspace.", event.ok ? "" : "failed");
    return;
  }

  if (event.message?.startsWith("model: retrying")) {
    addActivity("Reconnecting to the model", "The agent will retry automatically.");
    return;
  }

  addActivity(event.message || "Agent update", event.error?.message || "");
}

function handleModelRoute(event) {
  const detail = event.fallback
    ? `The previous provider was unavailable${event.error ? `: ${event.error}` : "."}`
    : event.summary;
  addActivity(`${event.fallback ? "Switched to" : "Using"} ${event.label}`, detail);
}

async function readEventStream(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let receivedResult = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += value;

    let boundary;
    while ((boundary = buffered.indexOf("\n\n")) !== -1) {
      const packet = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const eventName = packet.match(/^event: (.+)$/m)?.[1];
      const data = packet.match(/^data: (.+)$/m)?.[1];
      if (!eventName || !data) continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      if (eventName === "progress") handleProgress(parsed);
      if (eventName === "model") handleModelRoute(parsed);
      if (eventName === "result") {
        receivedResult = true;
        showResult(parsed.result, parsed.ok);
        if (parsed.cancelled) {
          resultTitle.textContent = "Task cancelled";
          addActivity("Task cancelled", "Completed changes were kept in the active project.", "failed");
          continue;
        }
        const detail = parsed.ok
          ? `${parsed.model ? `Finished with ${parsed.model}. ` : ""}Review the outcome for details.`
          : parsed.result;
        addActivity(parsed.ok ? "Agent finished the task" : "Agent stopped with an issue", detail, parsed.ok ? "" : "failed");
      }
    }
  }

  return receivedResult;
}

async function runTask(task) {
  activeTaskId = null;
  let taskStarted = false;
  let recoveredTask = false;
  setRunning(true);
  clearActivity();
  addActivity("Task submitted", task, "user");
  resultTitle.textContent = "Agent is working";
  resultMark.textContent = "…";
  resultText.textContent = "Following the task, checking changes, and waiting to verify the result.";
  resultCard.classList.remove("is-success", "is-error");

  try {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ task, mode: modelMode.value }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));

      if (response.status === 409) {
        recoveredTask = await refreshActiveTask({ announce: true });
        if (recoveredTask) return;
      }

      throw new Error(body.error || "The agent could not start this task.");
    }

    taskStarted = true;
    activeTaskId = response.headers.get("x-task-id");
    cancelButton.disabled = !activeTaskId;
    const receivedResult = await readEventStream(response);
    if (!receivedResult) {
      throw new Error("The task stream ended before the agent returned a result.");
    }
    await refreshContext();
  } catch (error) {
    if (taskStarted) {
      recoveredTask = await refreshActiveTask({ announce: true });
      if (!recoveredTask) {
        showRequestError(
          "The task started, but its live connection was interrupted before a final result arrived. Completed changes were kept. Refresh the dashboard, then review the project before starting another task.",
          "Task connection interrupted"
        );
      }
    } else {
      showRequestError(error.message || "The local agent is unavailable.");
    }
  } finally {
    if (!recoveredTask) setRunning(false);
  }
}

async function cancelTask() {
  if (!activeTaskId) return;

  cancelButton.disabled = true;
  cancelButton.textContent = "Cancelling…";
  taskHint.textContent = "Cancelling the current task. Changes already completed will remain.";

  try {
    const response = await fetch("/api/tasks/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ taskId: activeTaskId }),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 409 && !(await refreshActiveTask({ announceCompletion: true }))) {
        return;
      }
      throw new Error(body.error || "The task could not be cancelled.");
    }

    addActivity("Cancellation requested", "Finishing the current safe step and closing the task.");
  } catch (error) {
    cancelButton.disabled = false;
    cancelButton.textContent = "Cancel task";
    addActivity("Could not cancel the task", error.message || "Try again in a moment.", "failed");
  }
}

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.focus();
    taskHint.textContent = "Add a short task description to begin.";
    return;
  }
  runTask(task);
});

taskInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    taskForm.requestSubmit();
  }
});

modelMode.addEventListener("change", () => {
  modelNote.textContent = modelNotes[modelMode.value];
});

runProjectButton.addEventListener("click", toggleProjectRunner);
cancelButton.addEventListener("click", cancelTask);

for (const suggestion of document.querySelectorAll("[data-prompt]")) {
  suggestion.addEventListener("click", () => {
    taskInput.value = suggestion.dataset.prompt;
    taskInput.focus();
  });
}

setRunning(false);
refreshActiveTask({ announce: true, replaceActivity: true });
refreshContext();
refreshModelHealth();
