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
const previewProjectButton = document.querySelector("#preview-project");
const downloadProject = document.querySelector("#download-project");
const deliveryStatus = document.querySelector("#delivery-status");
const evaluationScore = document.querySelector("#evaluation-score");
const evaluationSummary = document.querySelector("#evaluation-summary");
const evaluationChecks = document.querySelector("#evaluation-checks");
const planProgress = document.querySelector("#plan-progress");
const planSummary = document.querySelector("#plan-summary");
const planMilestones = document.querySelector("#plan-milestones");
const runEvaluationsButton = document.querySelector("#run-evaluations");
const runLiveEvaluationsButton = document.querySelector("#run-live-evaluations");
const agentEvaluationStatus = document.querySelector("#evaluation-status");
const agentEvaluationPassRate = document.querySelector("#evaluation-pass-rate");
const agentEvaluationResults = document.querySelector("#evaluation-results");
const historySummary = document.querySelector("#history-summary");
const historyList = document.querySelector("#history-list");
const githubBadge = document.querySelector("#github-badge");
const githubSummary = document.querySelector("#github-summary");
const publishGitHubButton = document.querySelector("#publish-github");
const previewDialog = document.querySelector("#preview-dialog");
const previewFrame = document.querySelector("#project-preview-frame");
const closePreviewButton = document.querySelector("#close-preview");
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
  projectReadiness: "Checked project readiness",
  createProjectPlan: "Saved project milestones",
  readProjectPlan: "Read project milestones",
  updateMilestone: "Updated a milestone",
  readFile: "Read a file",
  writeFile: "Wrote a file",
  editFile: "Updated a file",
  terminal: "Ran a development command",
  test: "Ran tests",
};

const modelNotes = {
  auto: "Auto starts with the quick open-weight lane and moves through the strongest matching fallback when needed.",
  nano: "Start with NVIDIA's compact open-weight coding and reasoning model.",
  oss: "Use OpenAI's lightweight open-weight reasoning model for responsive coding work.",
  llama: "Use Meta's open-weight general coding and instruction model.",
  kimi: "Use Moonshot's open-weight agentic coding model for longer tool-driven work.",
  oss120: "Use the largest GPT-OSS route for deep open-weight reasoning.",
  ultra: "Start with NVIDIA's frontier open-weight coding and tool-use model.",
  glm: "Start with maximum depth for complex, long-horizon work, with broad open-weight fallbacks.",
};

let workspaceContext = { project: null };
let projectStatus = { state: "idle", project: null, url: null };
let staticPreviewStatus = {
  state: "idle",
  project: null,
  url: "/api/projects/preview/",
  available: false,
  message: "Select a project to preview its static website or download a safe source archive.",
};
let projectEvaluation = {
  state: "idle",
  project: null,
  score: 0,
  message: "Select a project to see its local engineering readiness checks.",
  checks: [],
};
let savedProjectPlan = {
  state: "idle",
  project: null,
  goal: null,
  progress: { completed: 0, total: 0 },
  milestones: [],
  message: "Select a project to see its saved milestone plan.",
};
let agentEvaluation = {
  state: "loading",
  total: 0,
  passed: 0,
  passRate: null,
  message: "Loading local baseline status…",
  results: [],
};
let taskHistory = {
  state: "loading",
  records: [],
  message: "Loading local task history…",
};
let githubStatus = {
  state: "loading",
  configured: false,
  repository: null,
  branch: null,
  message: "Checking GitHub configuration…",
};
let activeTaskId = null;
let taskStatusKnown = false;
let recoveringActiveTask = false;
let activeTaskPoll = null;
let staticPreviewRequest = 0;

const ACTIVE_TASK_POLL_INTERVAL_MS = 2_500;
const STATIC_PREVIEW_STATUS_PATHS = ["/api/projects/preview", "/api/projects/preview/status"];
const STATIC_PREVIEW_ROOT = "/api/projects/preview/";
const PROJECT_DOWNLOAD_PATH = "/api/projects/download";

function setConnection(text, offline = false) {
  connection.lastElementChild.textContent = text;
  connection.firstElementChild.style.background = offline ? "var(--coral)" : "var(--aqua)";
}

function setRunning(isRunning) {
  const taskControlsDisabled = isRunning || !taskStatusKnown;
  runButton.disabled = taskControlsDisabled;
  taskInput.disabled = taskControlsDisabled;
  modelMode.disabled = taskControlsDisabled;
  for (const control of document.querySelectorAll("[data-prompt], #project-list button")) {
    control.disabled = taskControlsDisabled;
  }
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

function safeStaticPreviewUrl(candidate) {
  const fallback = new URL(STATIC_PREVIEW_ROOT, window.location.origin);

  if (typeof candidate !== "string" || !candidate.trim()) {
    return fallback.pathname;
  }

  try {
    const parsed = new URL(candidate, window.location.origin);
    const isStaticPreview = parsed.pathname === STATIC_PREVIEW_ROOT
      || parsed.pathname.startsWith(STATIC_PREVIEW_ROOT);

    if (parsed.origin !== window.location.origin || !isStaticPreview) {
      return fallback.pathname;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback.pathname;
  }
}

function safeProjectDownloadUrl(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;

  try {
    const parsed = new URL(candidate, window.location.origin);

    if (parsed.origin !== window.location.origin || parsed.pathname !== PROJECT_DOWNLOAD_PATH) {
      return null;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function downloadUrlFromPreviewPayload(payload) {
  if (payload && Object.hasOwn(payload, "downloadUrl")) {
    return safeProjectDownloadUrl(payload.downloadUrl);
  }

  // Older dashboard servers did not include downloadUrl in preview metadata.
  // Keep the button compatible with that contract without trusting arbitrary URLs.
  return PROJECT_DOWNLOAD_PATH;
}

function renderStaticPreview() {
  const hasProject = Boolean(workspaceContext.project);
  const previewMatchesActiveProject = !staticPreviewStatus.project
    || staticPreviewStatus.project === workspaceContext.project;
  const canPreview = hasProject && previewMatchesActiveProject && staticPreviewStatus.available;
  const safeDownloadUrl = safeProjectDownloadUrl(staticPreviewStatus.downloadUrl);
  const canDownload = hasProject && Boolean(safeDownloadUrl);

  previewProjectButton.disabled = !canPreview;
  previewProjectButton.textContent = canPreview ? "Preview here" : "Preview unavailable";

  const downloadUrl = canDownload ? safeDownloadUrl : "#";
  downloadProject.href = downloadUrl;
  downloadProject.setAttribute("aria-disabled", String(!canDownload));
  downloadProject.tabIndex = canDownload ? 0 : -1;

  if (!hasProject) {
    deliveryStatus.textContent = "Select a project to preview its static website or download a safe source archive.";
    return;
  }

  if (canPreview) {
    deliveryStatus.textContent = `${workspaceContext.project} is ready for an isolated web preview. You can also download its safe source archive.`;
    return;
  }

  deliveryStatus.textContent = staticPreviewStatus.message
    || "This project has no safe static entry page to preview here. Its safe source archive is still available to download.";
}

function renderProjectEvaluation() {
  evaluationScore.textContent = workspaceContext.project ? String(projectEvaluation.score ?? 0) : "—";
  evaluationSummary.textContent = projectEvaluation.message
    || "Project readiness checks are temporarily unavailable.";
  evaluationChecks.textContent = "";

  for (const check of projectEvaluation.checks || []) {
    const item = document.createElement("li");
    item.className = `evaluation-check is-${check.status || "warn"}`;

    const copy = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = check.label || "Project check";
    const detail = document.createElement("p");
    detail.textContent = check.detail || "No detail is available.";
    copy.append(label, detail);
    item.append(copy);
    evaluationChecks.append(item);
  }
}

function renderProjectPlan() {
  const progress = savedProjectPlan.progress || { completed: 0, total: 0 };
  planProgress.textContent = workspaceContext.project ? `${progress.completed || 0}/${progress.total || 0}` : "—";
  planSummary.textContent = savedProjectPlan.message
    || savedProjectPlan.goal
    || "Project plan metadata is temporarily unavailable.";
  planMilestones.textContent = "";

  for (const milestone of savedProjectPlan.milestones || []) {
    const item = document.createElement("li");
    item.className = `plan-milestone is-${milestone.status || "pending"}`;
    const title = document.createElement("strong");
    title.textContent = `${milestone.status || "pending"} · ${milestone.title || milestone.id || "Milestone"}`;
    const detail = document.createElement("p");
    const dependencies = Array.isArray(milestone.dependsOn) && milestone.dependsOn.length > 0
      ? `Depends on: ${milestone.dependsOn.join(", ")}. `
      : "";
    detail.textContent = `${dependencies}${milestone.notes || milestone.description || "No notes yet."}`;
    item.append(title, detail);
    planMilestones.append(item);
  }
}

async function refreshProjectEvaluation() {
  const projectAtRequest = workspaceContext.project;

  if (!projectAtRequest) {
    projectEvaluation = {
      state: "idle",
      project: null,
      score: 0,
      message: "Select a project to see its local engineering readiness checks.",
      checks: [],
    };
    renderProjectEvaluation();
    return;
  }

  try {
    const response = await fetch("/api/projects/evaluation", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Project readiness checks are unavailable.");
    const evaluation = await response.json();
    if (workspaceContext.project !== projectAtRequest) return;
    projectEvaluation = evaluation;
  } catch {
    if (workspaceContext.project !== projectAtRequest) return;
    projectEvaluation = {
      state: "unavailable",
      project: projectAtRequest,
      score: 0,
      message: "Project readiness checks are temporarily unavailable.",
      checks: [],
    };
  }

  renderProjectEvaluation();
}

async function refreshProjectPlan() {
  const projectAtRequest = workspaceContext.project;

  if (!projectAtRequest) {
    savedProjectPlan = {
      state: "idle",
      project: null,
      goal: null,
      progress: { completed: 0, total: 0 },
      milestones: [],
      message: "Select a project to see its saved milestone plan.",
    };
    renderProjectPlan();
    return;
  }

  try {
    const response = await fetch("/api/projects/plan", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Project plan metadata is unavailable.");
    const plan = await response.json();
    if (workspaceContext.project !== projectAtRequest) return;
    savedProjectPlan = plan;
  } catch {
    if (workspaceContext.project !== projectAtRequest) return;
    savedProjectPlan = {
      state: "unavailable",
      project: projectAtRequest,
      goal: null,
      progress: { completed: 0, total: 0 },
      milestones: [],
      message: "Project plan metadata is temporarily unavailable.",
    };
  }

  renderProjectPlan();
}

function renderAgentEvaluation() {
  const isRunning = agentEvaluation.state === "running";
  runEvaluationsButton.disabled = isRunning;
  runLiveEvaluationsButton.disabled = isRunning;
  runEvaluationsButton.textContent = isRunning ? "Running…" : "Run baseline";
  runLiveEvaluationsButton.textContent = isRunning ? "Running…" : "Run live model";
  agentEvaluationStatus.textContent = agentEvaluation.message
    || "The local baseline is temporarily unavailable.";
  agentEvaluationPassRate.textContent = agentEvaluation.passRate === null
    ? "—"
    : `${agentEvaluation.passRate}%`;
  agentEvaluationResults.textContent = "";

  for (const result of agentEvaluation.results || []) {
    const item = document.createElement("li");
    item.className = `agent-evaluation-result is-${result.status || "fail"}`;
    const title = document.createElement("strong");
    title.textContent = `${result.status === "pass" ? "✓" : "!"} ${result.title || "Evaluation"}`;
    const summary = document.createElement("p");
    summary.textContent = result.summary || "No result summary is available.";
    const meta = document.createElement("p");
    meta.className = "evaluation-meta";
    meta.textContent = `${result.steps ?? 0} steps · ${result.durationMs ?? 0} ms · ${result.modelRoute || "local"}`;
    item.append(title, summary, meta);
    agentEvaluationResults.append(item);
  }
}

async function refreshAgentEvaluation() {
  try {
    const response = await fetch("/api/evaluations", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("The evaluation suite is unavailable.");
    agentEvaluation = await response.json();
  } catch {
    agentEvaluation = {
      state: "unavailable",
      total: 0,
      passed: 0,
      passRate: null,
      message: "The local baseline is temporarily unavailable.",
      results: [],
    };
  }

  renderAgentEvaluation();
}

function historyDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Unknown time"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderTaskHistory() {
  historySummary.textContent = taskHistory.message || "Local task history is temporarily unavailable.";
  historyList.textContent = "";

  if ((taskHistory.records || []).length === 0) {
    const item = document.createElement("li");
    item.className = "history-empty";
    item.textContent = taskHistory.state === "ready"
      ? "Completed task outcomes will appear here."
      : "No task history is available.";
    historyList.append(item);
    return;
  }

  for (const record of taskHistory.records) {
    const item = document.createElement("li");
    item.className = `history-item is-${record.status || "failed"}`;
    const title = document.createElement("strong");
    const state = record.status === "complete" ? "Completed" : record.status === "cancelled" ? "Cancelled" : "Needs attention";
    title.textContent = `${state}${record.project ? ` · ${record.project}` : ""}`;
    const detail = document.createElement("p");
    detail.textContent = `${historyDate(record.createdAt)} · ${record.durationMs ?? 0} ms${record.model ? ` · ${record.model}` : ""}`;
    item.append(title, detail);
    historyList.append(item);
  }
}

async function refreshTaskHistory() {
  try {
    const response = await fetch("/api/tasks/history", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Local task history is unavailable.");
    taskHistory = await response.json();
  } catch {
    taskHistory = {
      state: "unavailable",
      records: [],
      message: "Local task history is temporarily unavailable.",
    };
  }

  renderTaskHistory();
}

function renderGitHubStatus() {
  const ready = githubStatus.state === "ready" && githubStatus.configured && Boolean(workspaceContext.project);
  githubBadge.textContent = githubStatus.state === "ready" ? "Ready" : "Not configured";
  githubBadge.classList.toggle("is-ready", githubStatus.state === "ready");
  githubSummary.textContent = githubStatus.message || "GitHub configuration is temporarily unavailable.";
  publishGitHubButton.disabled = !ready;
  publishGitHubButton.textContent = ready ? "Publish current project" : "GitHub not configured";
}

async function refreshGitHubStatus() {
  try {
    const response = await fetch("/api/github", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("GitHub configuration is unavailable.");
    githubStatus = await response.json();
  } catch {
    githubStatus = {
      state: "unavailable",
      configured: false,
      repository: null,
      branch: null,
      message: "GitHub configuration is temporarily unavailable.",
    };
  }

  renderGitHubStatus();
}

async function publishGitHubProject() {
  if (publishGitHubButton.disabled || !githubStatus.repository) return;

  const confirmed = window.confirm(
    `Publish the current project to ${githubStatus.repository} on ${githubStatus.branch}? This adds or updates safe source files; it does not delete remote files.`
  );
  if (!confirmed) return;

  publishGitHubButton.disabled = true;
  publishGitHubButton.textContent = "Publishing…";

  try {
    const response = await fetch("/api/github/publish", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ confirmation: githubStatus.repository }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "GitHub publishing could not finish.");
    githubStatus = { ...githubStatus, message: body.message };
    addActivity("Published project source", `${body.created} created · ${body.updated} updated · ${body.repository}`);
  } catch (error) {
    githubStatus = { ...githubStatus, message: error.message || "GitHub publishing could not finish." };
    addActivity("GitHub publishing failed", githubStatus.message, "failed");
  }

  renderGitHubStatus();
}

async function runAgentEvaluations(mode = "deterministic") {
  const isLive = mode === "live";
  runEvaluationsButton.disabled = true;
  runLiveEvaluationsButton.disabled = true;
  runEvaluationsButton.textContent = "Running…";
  runLiveEvaluationsButton.textContent = "Running…";
  agentEvaluationStatus.textContent = isLive
    ? "Running live model checks with the selected model route…"
    : "Running isolated local baseline checks…";

  try {
    const response = await fetch("/api/evaluations/run", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ mode, modelMode: modelMode.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The evaluation suite could not finish.");
    agentEvaluation = body;
    addActivity(
      "Evaluation baseline completed",
      `${body.passed}/${body.total} ${isLive ? "live model" : "local baseline"} checks passed.`
    );
  } catch (error) {
    agentEvaluation = {
      ...agentEvaluation,
      state: "unavailable",
      message: error.message || "The evaluation suite could not finish.",
    };
    addActivity("Evaluation baseline failed", agentEvaluation.message, "failed");
  }

  renderAgentEvaluation();
}

function normalizeStaticPreviewStatus(payload, responseStatus) {
  const reportedState = typeof payload?.state === "string"
    ? payload.state
    : typeof payload?.status === "string"
      ? payload.status
      : null;
  const state = reportedState || (payload?.available === true || payload?.ready === true ? "ready" : "unavailable");
  const explicitlyUnavailable = state === "unavailable"
    || payload?.available === false
    || payload?.ready === false;
  const available = !explicitlyUnavailable && (
    payload?.available === true
    || payload?.ready === true
    || state === "ready"
    || state === "available"
    || state === "previewable"
  );

  return {
    state,
    project: typeof payload?.project === "string" ? payload.project : workspaceContext.project,
    url: safeStaticPreviewUrl(payload?.url || payload?.previewUrl),
    downloadUrl: downloadUrlFromPreviewPayload(payload),
    available: responseStatus >= 200 && responseStatus < 300 && available,
    message: typeof payload?.message === "string" ? payload.message : null,
  };
}

async function fetchStaticPreviewStatus() {
  let lastError = null;

  for (const path of STATIC_PREVIEW_STATUS_PATHS) {
    try {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      const isJson = response.headers.get("content-type")?.includes("application/json");
      const body = isJson ? await response.json().catch(() => ({})) : {};

      if (response.status === 404) {
        lastError = new Error(body.error || "Static preview status is unavailable.");
        continue;
      }

      // Some older servers can treat /preview as a static path instead of
      // metadata. If so, try the earlier /preview/status contract next.
      if (response.ok && !isJson) {
        lastError = new Error("Static preview status is unavailable.");
        continue;
      }

      if (!response.ok) {
        return normalizeStaticPreviewStatus({
          state: "unavailable",
          project: workspaceContext.project,
          message: body.error || "A static preview is not available for this project.",
          downloadUrl: downloadUrlFromPreviewPayload(body),
        }, response.status);
      }

      return normalizeStaticPreviewStatus(body, response.status);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Static preview status is unavailable.");
}

async function refreshStaticPreviewStatus() {
  const requestId = ++staticPreviewRequest;

  if (!workspaceContext.project) {
    staticPreviewStatus = {
      state: "idle",
      project: null,
      url: STATIC_PREVIEW_ROOT,
      downloadUrl: null,
      available: false,
      message: "Select a project to preview its static website or download a safe source archive.",
    };
    renderStaticPreview();
    return;
  }

  try {
    const status = await fetchStaticPreviewStatus();
    if (requestId !== staticPreviewRequest) return;
    staticPreviewStatus = status;
  } catch {
    if (requestId !== staticPreviewRequest) return;
    staticPreviewStatus = {
      state: "unavailable",
      project: workspaceContext.project,
      url: STATIC_PREVIEW_ROOT,
      downloadUrl: PROJECT_DOWNLOAD_PATH,
      available: false,
      message: "Static preview status is temporarily unavailable. You can still download the safe source archive.",
    };
  }

  renderStaticPreview();
}

function closeStaticPreview() {
  previewFrame.src = "about:blank";

  if (typeof previewDialog.close === "function" && previewDialog.open) {
    previewDialog.close();
    return;
  }

  previewDialog.removeAttribute("open");
}

function openStaticPreviewDialog() {
  if (previewProjectButton.disabled) return;

  const previewUrl = safeStaticPreviewUrl(staticPreviewStatus.url);
  previewFrame.src = previewUrl;

  if (typeof previewDialog.showModal === "function") {
    previewDialog.showModal();
    return;
  }

  previewDialog.setAttribute("open", "");
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
    modelHealth.textContent = `All ${health.models?.length || 0} model routes are available.`;
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
        button.disabled = !taskStatusKnown || Boolean(activeTaskId);
        button.classList.toggle("is-active", project === context.project);
        button.addEventListener("click", () => selectProject(project));
        item.append(button);
        projectList.append(item);
      }
    }

    await Promise.all([
      refreshProjectStatus(),
      refreshStaticPreviewStatus(),
      refreshProjectEvaluation(),
      refreshProjectPlan(),
      refreshGitHubStatus(),
    ]);
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
    closeStaticPreview();
    await refreshContext();
    await refreshTaskHistory();
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
previewProjectButton.addEventListener("click", openStaticPreviewDialog);
closePreviewButton.addEventListener("click", closeStaticPreview);
downloadProject.addEventListener("click", (event) => {
  if (downloadProject.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
  }
});
previewDialog.addEventListener("close", () => {
  previewFrame.src = "about:blank";
});
previewDialog.addEventListener("click", (event) => {
  if (event.target === previewDialog) closeStaticPreview();
});
cancelButton.addEventListener("click", cancelTask);
runEvaluationsButton.addEventListener("click", () => runAgentEvaluations());
runLiveEvaluationsButton.addEventListener("click", () => runAgentEvaluations("live"));
publishGitHubButton.addEventListener("click", publishGitHubProject);

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
refreshAgentEvaluation();
refreshTaskHistory();
refreshGitHubStatus();
