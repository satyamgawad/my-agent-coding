const projectTaskForm = document.querySelector("#project-task-form");
const projectTaskInput = document.querySelector("#project-task-input");
const projectRunButton = document.querySelector("#project-run-button");
const projectCancelButton = document.querySelector("#cancel-button");
const projectTaskHint = document.querySelector("#project-task-hint");
const projectTaskCount = document.querySelector("#project-task-count");
const requirementsGuide = document.querySelector("#requirements-guide");
const requirementsGuideMessage = document.querySelector("#requirements-guide-message");
const requirementsStarter = document.querySelector("#requirements-starter");
const newProjectChatButton = document.querySelector("#new-project-chat");
const projectHistorySummary = document.querySelector("#project-history-summary");
const projectHistoryList = document.querySelector("#project-history-list");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatRunButton = document.querySelector("#chat-run-button");
const chatCancelButton = document.querySelector("#chat-cancel-button");
const chatHint = document.querySelector("#chat-hint");
const chatTurns = document.querySelector("#chat-turns");
const chatEmpty = document.querySelector("#chat-empty");
const clearChatButton = document.querySelector("#clear-chat");
const newChatButton = document.querySelector("#new-chat");
const chatHistorySummary = document.querySelector("#chat-history-summary");
const chatHistoryList = document.querySelector("#chat-history-list");
const safetyGuard = document.querySelector("#safety-guard");
const connection = document.querySelector("#connection");
const modelRoute = document.querySelector("#model-route");
const activeProjectCard = document.querySelector("#active-project");
const activeProject = document.querySelector("#active-project strong");
const projectCount = document.querySelector("#project-count");
const projectList = document.querySelector("#project-list");
const deleteProjectButton = document.querySelector("#delete-project");
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
const conversationSummary = document.querySelector("#conversation-summary");
const conversationTurns = document.querySelector("#conversation-turns");
const clearConversationButton = document.querySelector("#clear-conversation");
const githubBadge = document.querySelector("#github-badge");
const githubSummary = document.querySelector("#github-summary");
const publishGitHubButton = document.querySelector("#publish-github");
const activityList = document.querySelector("#activity-list");
const activityState = document.querySelector("#activity-state");
const activityCount = document.querySelector("#activity-count");
const activityNote = document.querySelector("#activity-note");
const fileChangeList = document.querySelector("#file-change-list");
const toastRegion = document.querySelector("#toast-region");
const resultCard = document.querySelector(".result-card");
const resultTitle = document.querySelector("#result-title");
const resultText = document.querySelector("#result-text");
const resultMark = document.querySelector("#result-mark");
const resultMeta = document.querySelector("#result-meta");
const cosmicBackdrop = document.querySelector(".cosmic-backdrop");
const workspaceSwitches = [...document.querySelectorAll(".workspace-switch")];

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
  webSearch: "Searched the public web",
  readWebPage: "Read a public web page",
  visualCheck: "Ran browser visual checks",
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
let projectConversation = {
  state: "idle",
  turns: [],
  message: "Your tasks and final agent responses will appear here.",
};
let projectConversationHistory = {
  state: "loading",
  project: null,
  chats: [],
  message: "Loading saved task chats…",
};
let activeProjectConversationId = "agent-chat";
let hasDraftProjectConversation = false;
let chatConversation = {
  state: "idle",
  turns: [],
  message: "Start a conversation. Your chat is saved separately from every project.",
};
let chatHistory = {
  state: "loading",
  chats: [],
  message: "Loading saved chats…",
};
let activeChatId = "general-chat";
let hasDraftChat = false;
let githubStatus = {
  state: "loading",
  configured: false,
  repository: null,
  branch: null,
  message: "Checking GitHub configuration…",
};
let activeTaskId = null;
let activeTaskPurpose = null;
let taskStatusKnown = false;
let recoveringActiveTask = false;
let activeTaskPoll = null;
let staticPreviewRequest = 0;

const ACTIVE_TASK_POLL_INTERVAL_MS = 2_500;
const STATIC_PREVIEW_STATUS_PATHS = ["/api/projects/preview", "/api/projects/preview/status"];
const STATIC_PREVIEW_ROOT = "/api/projects/preview/";
const PROJECT_DOWNLOAD_PATH = "/api/projects/download";
const WORKSPACE_VIEW_STORAGE_KEY = "my-coding-agent:workspace-view";
const SAFETY_GUARD_STORAGE_KEY = "my-coding-agent:nvidia-safety-enabled";
const ACTIVE_CHAT_ID_STORAGE_KEY = "my-coding-agent:active-chat-id";
const ACTIVE_PROJECT_CONVERSATION_ID_STORAGE_KEY = "my-coding-agent:active-project-conversation-id";
const FILE_CHANGE_TOOLS = new Set(["writeFile", "editFile", "writeAgentSource", "editAgentSource"]);
const MAX_FILE_CHANGE_ITEMS = 5;

let activityEntries = 0;

function cleanAnswerText(value) {
  return String(value ?? "")
    .replace(/(?:<|&lt;)\s*br\s*\/?\s*(?:>|&gt;)/gi, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendInlineAnswerText(element, value) {
  const text = String(value ?? "");
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) {
      element.append(document.createTextNode(text.slice(cursor, match.index)));
    }

    const token = match[0];
    const formatted = document.createElement(token.startsWith("**") ? "strong" : "code");
    formatted.textContent = token.slice(token.startsWith("**") ? 2 : 1, token.startsWith("**") ? -2 : -1);
    element.append(formatted);
    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    element.append(document.createTextNode(text.slice(cursor)));
  }
}

function appendAnswerParagraph(container, lines) {
  if (lines.length === 0) return;
  const paragraph = document.createElement("p");
  appendInlineAnswerText(paragraph, lines.join(" "));
  container.append(paragraph);
}

function renderAnswerText(container, value) {
  const text = cleanAnswerText(value);
  container.textContent = "";

  if (!text) {
    container.textContent = "No response was returned.";
    return;
  }

  const lines = text.split("\n");
  let paragraphLines = [];
  let list = null;
  let listType = null;

  const flush = () => {
    appendAnswerParagraph(container, paragraphLines);
    paragraphLines = [];
    list = null;
    listType = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flush();
      continue;
    }

    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    const bulleted = line.match(/^[-*•]\s+(.+)$/);

    if (numbered || bulleted) {
      appendAnswerParagraph(container, paragraphLines);
      paragraphLines = [];
      const nextListType = numbered ? "ol" : "ul";
      if (!list || listType !== nextListType) {
        list = document.createElement(nextListType);
        list.className = "answer-list";
        listType = nextListType;
        container.append(list);
      }
      const item = document.createElement("li");
      appendInlineAnswerText(item, (numbered || bulleted)[1]);
      list.append(item);
      continue;
    }

    if (list) {
      list = null;
      listType = null;
    }

    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      appendAnswerParagraph(container, paragraphLines);
      paragraphLines = [];
      const title = document.createElement("h3");
      title.className = "answer-heading";
      appendInlineAnswerText(title, heading[1]);
      container.append(title);
      continue;
    }

    paragraphLines.push(line);
  }

  flush();
}

function setConnection(text, offline = false) {
  connection.lastElementChild.textContent = text;
  connection.firstElementChild.style.background = offline ? "var(--coral)" : "var(--aqua)";
}

function setModelRoute(label, fallback = false) {
  modelRoute.lastElementChild.textContent = label;
  modelRoute.classList.toggle("is-fallback", fallback);
}

function restoreSafetyGuardPreference() {
  try {
    safetyGuard.checked = window.localStorage.getItem(SAFETY_GUARD_STORAGE_KEY) === "true";
  } catch {
    safetyGuard.checked = false;
  }
}

function saveSafetyGuardPreference() {
  try {
    window.localStorage.setItem(SAFETY_GUARD_STORAGE_KEY, String(safetyGuard.checked));
  } catch {
    // The checkbox still applies to the current task when browser storage is unavailable.
  }
}

function isGeneralChatId(value) {
  return value === "general-chat" || /^general-chat-[a-f0-9]{32}$/.test(value || "");
}

function restoreActiveChatId() {
  try {
    const savedId = window.localStorage.getItem(ACTIVE_CHAT_ID_STORAGE_KEY);
    activeChatId = isGeneralChatId(savedId) ? savedId : "general-chat";
  } catch {
    activeChatId = "general-chat";
  }
}

function saveActiveChatId() {
  try {
    window.localStorage.setItem(ACTIVE_CHAT_ID_STORAGE_KEY, activeChatId);
  } catch {
    // The selected chat still works when browser privacy settings prevent
    // remembering it for the next local dashboard visit.
  }
}

function activeChatUrl(path) {
  const query = new URLSearchParams({ id: activeChatId || "general-chat" });
  return `${path}?${query}`;
}

function isProjectConversationId(value) {
  return value === "agent-chat" || /^agent-chat-(?:[a-z0-9]+(?:-[a-z0-9]+)*)-[a-f0-9]{32}$/.test(value || "");
}

function restoreActiveProjectConversationId() {
  try {
    const savedId = window.localStorage.getItem(ACTIVE_PROJECT_CONVERSATION_ID_STORAGE_KEY);
    activeProjectConversationId = isProjectConversationId(savedId) ? savedId : "agent-chat";
  } catch {
    activeProjectConversationId = "agent-chat";
  }
}

function saveActiveProjectConversationId() {
  try {
    window.localStorage.setItem(ACTIVE_PROJECT_CONVERSATION_ID_STORAGE_KEY, activeProjectConversationId);
  } catch {
    // The selected task chat still works when browser privacy settings prevent
    // remembering it for the next local dashboard visit.
  }
}

function activeProjectConversationUrl(path) {
  const query = new URLSearchParams({ id: activeProjectConversationId || "agent-chat" });
  return `${path}?${query}`;
}

function setWorkspaceView(view, { persist = true } = {}) {
  const target = view === "projects" ? "projects" : "chat";

  for (const panel of document.querySelectorAll("[data-workspace-view]")) {
    const active = panel.dataset.workspaceView === target;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }

  for (const button of workspaceSwitches) {
    const active = button.dataset.workspaceSwitch === target;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }

  if (persist) {
    try {
      window.localStorage.setItem(WORKSPACE_VIEW_STORAGE_KEY, target);
    } catch {
      // The workspace remains usable when browser privacy settings prevent
      // persisting the last selected view.
    }
  }
}

function restoreWorkspaceView() {
  try {
    const savedView = window.localStorage.getItem(WORKSPACE_VIEW_STORAGE_KEY);
    setWorkspaceView(savedView === "projects" ? "projects" : "chat", { persist: false });
  } catch {
    setWorkspaceView("chat", { persist: false });
  }
}

function moveWorkspaceFocus(event) {
  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
  event.preventDefault();

  const currentIndex = workspaceSwitches.indexOf(event.currentTarget);
  if (currentIndex === -1) return;

  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % workspaceSwitches.length;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + workspaceSwitches.length) % workspaceSwitches.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = workspaceSwitches.length - 1;
  if (nextIndex === currentIndex) return;

  const nextWorkspace = workspaceSwitches[nextIndex];
  nextWorkspace.focus();
  setWorkspaceView(nextWorkspace.dataset.workspaceSwitch);
}

function setRunning(isRunning) {
  const taskControlsDisabled = isRunning || !taskStatusKnown;
  projectRunButton.disabled = taskControlsDisabled;
  projectTaskInput.disabled = taskControlsDisabled;
  newProjectChatButton.disabled = taskControlsDisabled;
  chatRunButton.disabled = taskControlsDisabled;
  chatInput.disabled = taskControlsDisabled;
  newChatButton.disabled = taskControlsDisabled;
  safetyGuard.disabled = taskControlsDisabled;
  clearConversationButton.disabled = taskControlsDisabled || projectConversation.turns.length === 0;
  clearChatButton.disabled = taskControlsDisabled || chatConversation.turns.length === 0;
  for (const control of document.querySelectorAll("[data-prompt], #project-list button")) {
    control.disabled = taskControlsDisabled;
  }
  for (const control of document.querySelectorAll("[data-project-chat-thread]")) {
    control.disabled = taskControlsDisabled;
  }
  for (const control of document.querySelectorAll("[data-chat-prompt]")) {
    control.disabled = taskControlsDisabled;
  }
  for (const control of document.querySelectorAll("[data-chat-thread]")) {
    control.disabled = taskControlsDisabled;
  }
  for (const control of document.querySelectorAll("[data-requirements-starter]")) {
    control.disabled = taskControlsDisabled;
  }
  deleteProjectButton.disabled = taskControlsDisabled || !workspaceContext.project;
  projectRunButton.firstElementChild.textContent = isRunning ? "Working…" : "Run task";
  chatRunButton.firstElementChild.textContent = isRunning ? "Thinking…" : "Send message";
  projectTaskHint.textContent = isRunning
    ? "The agent is working through the project task and streaming its verified steps."
    : taskStatusKnown
      ? workspaceContext.project
        ? `Ready for another instruction on ${workspaceContext.project}. The saved conversation provides follow-up context.`
        : "Describe a new project or select one to continue it."
      : "Checking whether an earlier task is still running…";
  chatHint.textContent = isRunning
    ? "Thinking through your question or checking public sources. Your projects remain untouched."
    : taskStatusKnown
      ? "Chat can search public sources but never opens or changes your projects."
      : "Checking whether an earlier request is still running…";
  activityState.textContent = isRunning ? "Working" : "Ready";
  activityState.classList.toggle("is-working", isRunning);
  for (const button of [projectCancelButton, chatCancelButton]) {
    button.hidden = !isRunning;
    button.disabled = !isRunning || !activeTaskId;
  }

  if (!isRunning) {
    activeTaskId = null;
    activeTaskPurpose = null;
    projectCancelButton.textContent = "Cancel task";
    chatCancelButton.textContent = "Cancel reply";
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
    for (const button of [projectCancelButton, chatCancelButton]) {
      button.disabled = true;
      button.textContent = "Cancelling…";
    }
    projectTaskHint.textContent = "Cancelling the current task. Changes already completed will remain.";
    chatHint.textContent = "Cancelling the current reply.";
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
  activityEntries = 0;
  activityCount.textContent = "0 updates";
  activityNote.textContent = "Waiting for the next task.";
  clearFileChanges();
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

  const timestamp = document.createElement("time");
  const now = new Date();
  timestamp.dateTime = now.toISOString();
  timestamp.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  copy.append(timestamp);

  item.append(icon, copy);
  activityList.append(item);
  activityList.scrollTop = activityList.scrollHeight;
  activityEntries += 1;
  activityCount.textContent = `${activityEntries} update${activityEntries === 1 ? "" : "s"}`;
  activityNote.textContent = kind === "failed" ? "Action needs attention." : title;
}

function clearFileChanges() {
  fileChangeList.textContent = "";
  const empty = document.createElement("li");
  empty.className = "file-change-empty";
  empty.textContent = "Verified file updates will appear here.";
  fileChangeList.append(empty);
}

function addFileChange(tool, filePath) {
  if (!FILE_CHANGE_TOOLS.has(tool) || typeof filePath !== "string" || !filePath) return;

  const empty = fileChangeList.querySelector(".file-change-empty");
  if (empty) empty.remove();

  const item = document.createElement("li");
  item.className = "file-change-item";
  const action = document.createElement("strong");
  action.textContent = tool === "writeFile" || tool === "writeAgentSource" ? "Created or replaced" : "Updated";
  const file = document.createElement("span");
  file.textContent = filePath;
  item.append(action, file);
  fileChangeList.prepend(item);

  while (fileChangeList.children.length > MAX_FILE_CHANGE_ITEMS) {
    fileChangeList.lastElementChild?.remove();
  }
}

function showToast(message, kind = "info") {
  const toast = document.createElement("div");
  toast.className = `toast is-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");

  const text = document.createElement("span");
  text.textContent = message;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "Dismiss notification");
  dismiss.textContent = "×";
  toast.append(text, dismiss);

  const removeToast = () => toast.remove();
  dismiss.addEventListener("click", removeToast);
  toastRegion.append(toast);

  while (toastRegion.children.length > 3) {
    toastRegion.firstElementChild?.remove();
  }

  window.setTimeout(removeToast, 5_000);
}

function isRequirementsPrompt(text) {
  return typeof text === "string" && text.startsWith("Before I create the project, I need a few requirements");
}

function setRequirementsGuide(awaitingRequirements) {
  requirementsGuide.classList.toggle("is-awaiting", awaitingRequirements);
  requirementsGuideMessage.textContent = awaitingRequirements
    ? "Brief requested. Reply below with the purpose, key features, and visual direction so the agent can build the right project."
    : "Tell the agent “Create an app” first. It will ask about the purpose, features, and UI/UX before it builds.";
  requirementsStarter.textContent = awaitingRequirements ? "Write requirements" : "Plan first";
}

function updateProjectTaskCount() {
  projectTaskCount.textContent = `${projectTaskInput.value.length.toLocaleString()} / 16,000`;
}

function formatTaskDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1_000) return "under 1 sec";
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)} sec`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`;
}

function renderResultMeta({ model, durationMs, steps } = {}) {
  const details = [];
  if (typeof model === "string" && model) details.push(model);
  const duration = formatTaskDuration(durationMs);
  if (duration) details.push(duration);
  if (Number.isInteger(steps) && steps > 0) details.push(`${steps} tool step${steps === 1 ? "" : "s"}`);

  resultMeta.hidden = details.length === 0;
  resultMeta.textContent = details.join(" · ");
}

function showResult(text, ok, metadata = {}) {
  const awaitingRequirements = ok && isRequirementsPrompt(text);
  const timedOut = metadata.timedOut === true;
  resultCard.classList.toggle("is-success", ok);
  resultCard.classList.toggle("is-error", !ok);
  resultCard.classList.toggle("is-requirements", awaitingRequirements);
  resultTitle.textContent = awaitingRequirements ? "Project brief needed" : timedOut ? "Task timed out" : ok ? "Task complete" : "Task needs attention";
  resultMark.textContent = awaitingRequirements ? "01" : timedOut ? "⌛" : ok ? "✦" : "!";
  renderAnswerText(resultText, text);
  renderResultMeta(metadata);
  if (activeTaskPurpose !== "chat") setRequirementsGuide(awaitingRequirements);
  if (!awaitingRequirements) {
    showToast(timedOut ? "Task timed out — completed changes were kept." : ok ? "Task complete — verified result is ready." : "Task needs attention — review the result.", ok ? "success" : "error");
  }
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

function projectCardStatus(project) {
  if (project !== workspaceContext.project) {
    return "Select to inspect";
  }

  if (projectEvaluation.state === "ready" || typeof projectEvaluation.score === "number") {
    return `Active · ${projectEvaluation.score ?? 0}/100 ready`;
  }

  return "Active workspace";
}

function renderProjectList() {
  const projects = workspaceContext.projects || [];
  projectList.textContent = "";

  if (projects.length === 0) {
    const item = document.createElement("li");
    item.className = "empty-state";
    item.textContent = "Projects you create will appear here.";
    projectList.append(item);
    return;
  }

  for (const project of projects) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const isActive = project === workspaceContext.project;
    button.type = "button";
    button.className = "project-card-button";
    button.disabled = !taskStatusKnown || Boolean(activeTaskId);
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-label", `${isActive ? "Active project" : "Open project"}: ${project}`);

    const name = document.createElement("strong");
    name.textContent = project;
    const meta = document.createElement("span");
    meta.className = "project-card-meta";
    meta.textContent = projectCardStatus(project);
    const action = document.createElement("span");
    action.className = "project-card-action";
    action.textContent = isActive ? "Current" : "Open";
    button.append(name, meta, action);
    button.addEventListener("click", () => selectProject(project));
    item.append(button);
    projectList.append(item);
  }
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

  previewProjectButton.href = canPreview ? safeStaticPreviewUrl(staticPreviewStatus.url) : "#";
  previewProjectButton.setAttribute("aria-disabled", String(!canPreview));
  previewProjectButton.tabIndex = canPreview ? 0 : -1;
  previewProjectButton.textContent = canPreview ? "Open preview ↗" : "Preview unavailable";

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

  renderProjectList();
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

function renderProjectConversation() {
  conversationSummary.textContent = projectConversation.message
    || "Agent conversation history is temporarily unavailable.";
  conversationTurns.textContent = "";
  clearConversationButton.disabled = projectConversation.turns.length === 0 || Boolean(activeTaskId) || !taskStatusKnown;

  for (const turn of projectConversation.turns || []) {
    for (const [speaker, content] of [["user", turn.task], ["agent", turn.outcome]]) {
      const item = document.createElement("li");
      item.className = `conversation-turn is-${speaker}`;
      const label = document.createElement("strong");
      label.textContent = speaker === "user" ? "YOU" : "AGENT";
      const message = document.createElement("div");
      message.className = "answer-content";
      renderAnswerText(message, content || "No message was saved.");
      item.append(label, message);

      if (speaker === "agent" && turn.completedAt) {
        const completedAt = document.createElement("time");
        completedAt.dateTime = turn.completedAt;
        completedAt.textContent = historyDate(turn.completedAt);
        item.append(completedAt);
      }

      conversationTurns.append(item);
    }
  }
}

function renderProjectConversationHistory() {
  const chats = projectConversationHistory.chats || [];
  projectHistoryList.textContent = "";
  projectHistorySummary.textContent = projectConversationHistory.message
    || "Saved project task chats are ready to continue.";
  newProjectChatButton.disabled = !taskStatusKnown || Boolean(activeTaskId);

  if (chats.length === 0) {
    const empty = document.createElement("li");
    empty.className = "project-history-empty";
    empty.textContent = hasDraftProjectConversation
      ? "This new task chat is ready for your next instruction."
      : projectConversationHistory.state === "ready"
        ? "Your earlier task chats will appear here."
        : "Saved task chats are unavailable right now.";
    projectHistoryList.append(empty);
    return;
  }

  for (const chat of chats) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const active = chat.id === activeProjectConversationId;
    button.type = "button";
    button.className = "project-history-thread";
    button.dataset.projectChatThread = chat.id;
    button.disabled = !taskStatusKnown || Boolean(activeTaskId);
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
    button.title = chat.task || "Saved project task chat";

    const title = document.createElement("strong");
    title.textContent = chatThreadTitle(chat.task);
    const detail = document.createElement("span");
    const turnLabel = `${chat.turns || 0} turn${chat.turns === 1 ? "" : "s"}`;
    detail.textContent = `${turnLabel} · ${chat.project || "Earlier task"}`;
    button.append(title, detail);
    button.addEventListener("click", () => selectProjectConversation(chat.id));
    item.append(button);
    projectHistoryList.append(item);
  }
}

async function refreshProjectConversation() {
  try {
    const response = await fetch(activeProjectConversationUrl("/api/conversation"), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Agent conversation history is unavailable.");
    const conversation = await response.json();
    projectConversation = conversation;
  } catch {
    projectConversation = {
      state: "unavailable",
      turns: [],
      message: "Agent conversation history is temporarily unavailable.",
    };
  }

  renderProjectConversation();
}

async function refreshProjectConversationHistory() {
  try {
    const response = await fetch("/api/project/conversations", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Saved project task chats are unavailable.");
    projectConversationHistory = await response.json();

    if (!hasDraftProjectConversation) {
      const savedChat = projectConversationHistory.chats?.find((chat) => chat.id === activeProjectConversationId);
      activeProjectConversationId = savedChat?.id || projectConversationHistory.chats?.[0]?.id || "agent-chat";
      saveActiveProjectConversationId();
    }
  } catch {
    projectConversationHistory = {
      state: "unavailable",
      project: workspaceContext.project || null,
      chats: [],
      message: "Saved project task chats are temporarily unavailable.",
    };
  }

  renderProjectConversationHistory();
}

async function refreshProjectConversationWorkspace() {
  await refreshProjectConversationHistory();
  await refreshProjectConversation();
}

async function selectProjectConversation(id) {
  if (!isProjectConversationId(id) || Boolean(activeTaskId) || id === activeProjectConversationId) return;
  activeProjectConversationId = id;
  hasDraftProjectConversation = false;
  saveActiveProjectConversationId();
  renderProjectConversationHistory();
  await refreshProjectConversation();
}

async function startNewProjectConversation() {
  if (newProjectChatButton.disabled) return;
  newProjectChatButton.disabled = true;

  try {
    const response = await fetch("/api/project/conversations", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    const conversation = await response.json();
    if (!response.ok || !isProjectConversationId(conversation.id)) {
      throw new Error(conversation.error || "A new project task chat could not be started.");
    }

    activeProjectConversationId = conversation.id;
    hasDraftProjectConversation = true;
    projectConversation = conversation;
    saveActiveProjectConversationId();
    renderProjectConversationHistory();
    renderProjectConversation();
    projectTaskInput.focus();
  } catch (error) {
    showToast(error.message || "A new project task chat could not be started.", "error");
    renderProjectConversationHistory();
  }
}

async function clearProjectConversation() {
  if (clearConversationButton.disabled) return;

  if (!window.confirm("Clear this saved project task chat? This cannot be undone.")) {
    return;
  }

  clearConversationButton.disabled = true;

  try {
    const response = await fetch(activeProjectConversationUrl("/api/conversation/clear"), {
      method: "POST",
      headers: { accept: "application/json" },
    });
    const conversation = await response.json();
    if (!response.ok) throw new Error(conversation.error || "Agent conversation could not be cleared.");
    projectConversation = conversation;
    hasDraftProjectConversation = true;
    await refreshProjectConversationHistory();
    addActivity("Cleared project task chat", "Removed saved follow-up context for this task chat.");
  } catch (error) {
    addActivity("Could not clear conversation", error.message || "Try again in a moment.", "failed");
  }

  renderProjectConversation();
}

function chatThreadTitle(value) {
  const normalized = String(value || "New chat").replace(/\s+/g, " ").trim();
  return normalized.length > 54 ? `${normalized.slice(0, 53)}…` : normalized;
}

function renderChatHistory() {
  const chats = chatHistory.chats || [];
  chatHistoryList.textContent = "";
  chatHistorySummary.textContent = chatHistory.message
    || "Your saved general chats stay private on this device.";
  newChatButton.disabled = !taskStatusKnown || Boolean(activeTaskId);

  if (chats.length === 0) {
    const empty = document.createElement("li");
    empty.className = "chat-history-empty";
    empty.textContent = hasDraftChat
      ? "This new chat is ready for your first question."
      : chatHistory.state === "ready"
        ? "Your earlier chats will appear here."
        : "Saved chats are unavailable right now.";
    chatHistoryList.append(empty);
    return;
  }

  for (const chat of chats) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const active = chat.id === activeChatId;
    button.type = "button";
    button.className = "chat-history-thread";
    button.dataset.chatThread = chat.id;
    button.disabled = !taskStatusKnown || Boolean(activeTaskId);
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
    button.title = chat.task || "Saved chat";

    const title = document.createElement("strong");
    title.textContent = chatThreadTitle(chat.task);
    const detail = document.createElement("span");
    const turnLabel = `${chat.turns || 0} turn${chat.turns === 1 ? "" : "s"}`;
    detail.textContent = `${turnLabel} · ${historyDate(chat.completedAt)}`;
    button.append(title, detail);
    button.addEventListener("click", () => selectChatConversation(chat.id));
    item.append(button);
    chatHistoryList.append(item);
  }
}

function renderChatConversation() {
  chatTurns.textContent = "";
  const turns = chatConversation.turns || [];
  chatEmpty.hidden = turns.length > 0;
  chatEmpty.textContent = chatConversation.message
    || "Start a conversation. Your chat is saved separately from every project.";
  clearChatButton.disabled = turns.length === 0 || Boolean(activeTaskId) || !taskStatusKnown;

  for (const turn of turns) {
    for (const [speaker, content] of [["user", turn.task], ["agent", turn.outcome]]) {
      const item = document.createElement("li");
      item.className = `chat-turn is-${speaker}`;

      const label = document.createElement("strong");
      label.textContent = speaker === "user" ? "YOU" : "SATYAM'S AGENT";
      const message = document.createElement("div");
      message.className = "answer-content";
      renderAnswerText(message, content || "No message was saved.");
      item.append(label, message);

      if (speaker === "agent" && turn.completedAt) {
        const completedAt = document.createElement("time");
        completedAt.dateTime = turn.completedAt;
        completedAt.textContent = historyDate(turn.completedAt);
        item.append(completedAt);
      }

      chatTurns.append(item);
    }
  }

  chatTurns.scrollTop = chatTurns.scrollHeight;
}

async function refreshChatHistory() {
  try {
    const response = await fetch("/api/chat/conversations", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Saved general chats are unavailable.");
    chatHistory = await response.json();

    if (!hasDraftChat) {
      const savedChat = chatHistory.chats?.find((chat) => chat.id === activeChatId);
      activeChatId = savedChat?.id || chatHistory.chats?.[0]?.id || "general-chat";
      saveActiveChatId();
    }
  } catch {
    chatHistory = {
      state: "unavailable",
      chats: [],
      message: "Saved general chats are temporarily unavailable.",
    };
  }

  renderChatHistory();
}

async function refreshChatConversation() {
  try {
    const response = await fetch(activeChatUrl("/api/chat/conversation"), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("General chat history is unavailable.");
    chatConversation = await response.json();
  } catch {
    chatConversation = {
      state: "unavailable",
      id: activeChatId,
      turns: [],
      message: "General chat history is temporarily unavailable.",
    };
  }

  renderChatConversation();
}

async function refreshChatWorkspace() {
  await refreshChatHistory();
  await refreshChatConversation();
}

async function selectChatConversation(id) {
  if (!isGeneralChatId(id) || Boolean(activeTaskId) || id === activeChatId) return;
  activeChatId = id;
  hasDraftChat = false;
  saveActiveChatId();
  renderChatHistory();
  await refreshChatConversation();
}

async function startNewChat() {
  if (newChatButton.disabled) return;
  newChatButton.disabled = true;

  try {
    const response = await fetch("/api/chat/conversations", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    const conversation = await response.json();
    if (!response.ok || !isGeneralChatId(conversation.id)) {
      throw new Error(conversation.error || "A new chat could not be started.");
    }

    activeChatId = conversation.id;
    hasDraftChat = true;
    chatConversation = conversation;
    saveActiveChatId();
    renderChatHistory();
    renderChatConversation();
    chatInput.focus();
  } catch (error) {
    showToast(error.message || "A new chat could not be started.", "error");
    renderChatHistory();
  }
}

async function clearChatConversation() {
  if (clearChatButton.disabled) return;

  if (!window.confirm("Clear this saved general chat? This cannot be undone.")) {
    return;
  }

  clearChatButton.disabled = true;

  try {
    const response = await fetch(activeChatUrl("/api/chat/conversation/clear"), {
      method: "POST",
      headers: { accept: "application/json" },
    });
    const conversation = await response.json();
    if (!response.ok) throw new Error(conversation.error || "General chat could not be cleared.");
    chatConversation = conversation;
    hasDraftChat = true;
    await refreshChatHistory();
    showToast("General chat cleared.", "success");
  } catch (error) {
    showToast(error.message || "General chat could not be cleared.", "error");
  }

  renderChatConversation();
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
    ? "Running live model checks with the automatic model route…"
    : "Running isolated local baseline checks…";

  try {
    const response = await fetch("/api/evaluations/run", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ mode }),
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

async function refreshProjectStatus() {
  const response = await fetch("/api/projects/run", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Project preview is unavailable.");
  projectStatus = await response.json();
  renderProjectRunner();
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
    activeProjectCard.classList.toggle("has-project", Boolean(context.project));
    deleteProjectButton.disabled = !context.project || !taskStatusKnown || Boolean(activeTaskId);
    renderProjectList();

    await Promise.all([
      refreshProjectStatus(),
      refreshStaticPreviewStatus(),
      refreshProjectEvaluation(),
      refreshProjectPlan(),
      refreshProjectConversationWorkspace(),
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
    await refreshContext();
    await refreshTaskHistory();
    addActivity(`Selected ${name}`, "It is ready to run or receive a new task.");
  } catch (error) {
    showRequestError(error.message || "The project could not be selected.");
  }
}

async function deleteActiveProject() {
  const project = workspaceContext.project;
  if (!project || deleteProjectButton.disabled) return;

  const confirmation = window.prompt(
    `This permanently deletes the local project "${project}" and its saved private plan metadata. Type ${project} to confirm.`
  );

  if (confirmation === null) return;

  if (confirmation !== project) {
    showRequestError(`Project was not deleted. Type ${project} exactly to confirm.`, "Deletion cancelled");
    return;
  }

  deleteProjectButton.disabled = true;
  deleteProjectButton.textContent = "Deleting…";

  try {
    const response = await fetch("/api/projects/delete", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ name: project, confirmation }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The project could not be deleted.");

    workspaceContext = body;
    await refreshContext();
    await refreshTaskHistory();
    addActivity(`Deleted ${project}`, "Its local source files and saved project handoff were removed.");
    showToast(`${project} was deleted from this device.`, "success");
  } catch (error) {
    showRequestError(error.message || "The project could not be deleted.", "Could not delete project");
  } finally {
    deleteProjectButton.textContent = "Delete selected project";
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
    showToast(isRunning ? "Local project preview stopped." : "Local project preview is running.", "success");
  } catch (error) {
    showRequestError(error.message || "The project preview could not be started.");
  } finally {
    renderProjectRunner();
  }
}

function handleProgress(event) {
  if (event.tool) {
    const label = toolLabels[event.tool] || event.tool;
    const fileDetail = event.filePath ? `${event.filePath} · verified by the local workspace.` : "Verified by the local workspace.";
    addActivity(label, event.error?.message || fileDetail, event.ok ? "" : "failed");
    if (event.ok) addFileChange(event.tool, event.filePath);
    return;
  }

  if (event.message?.startsWith("model: retrying")) {
    addActivity("Reconnecting to the model", "The agent will retry automatically.");
    return;
  }

  addActivity(event.message || "Agent update", event.error?.message || "");
}

function handleModelRoute(event) {
  setModelRoute(
    event.fallback ? `Local fallback · ${event.label}` : event.label,
    event.fallback
  );
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
        showResult(parsed.result, parsed.ok, parsed);
        if (parsed.cancelled) {
          resultTitle.textContent = parsed.timedOut ? "Task timed out" : "Task cancelled";
          addActivity(parsed.timedOut ? "Task timed out" : "Task cancelled", parsed.timedOut ? "The maximum task time was reached. Completed changes were kept." : "Completed changes were kept in the active project.", "failed");
          continue;
        }
        const awaitingRequirements = parsed.ok && isRequirementsPrompt(parsed.result);
        const detail = awaitingRequirements
          ? "Reply with the project requirements, then the agent will begin building."
          : parsed.ok
            ? `${parsed.model ? `Finished with ${parsed.model}. ` : ""}Review the outcome for details.`
            : parsed.result;
        addActivity(awaitingRequirements ? "Project brief requested" : parsed.ok ? "Agent finished the task" : "Agent stopped with an issue", detail, parsed.ok ? "" : "failed");
      }
    }
  }

  return receivedResult;
}

async function runTask(task, purpose = "project") {
  activeTaskId = null;
  activeTaskPurpose = purpose;
  let taskStarted = false;
  let recoveredTask = false;
  setRunning(true);
  clearActivity();
  addActivity(purpose === "chat" ? "Chat message sent" : "Project task submitted", task, "user");
  resultTitle.textContent = "Agent is working";
  resultMark.textContent = "…";
  resultText.textContent = purpose === "chat"
    ? "Preparing a project-safe answer."
    : "Following the task, checking changes, and waiting to verify the result.";
  resultCard.classList.remove("is-success", "is-error", "is-requirements");
  if (purpose === "project") setRequirementsGuide(false);

  try {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        task,
        purpose,
        safety: safetyGuard.checked,
        conversationId: purpose === "chat" ? activeChatId : activeProjectConversationId,
      }),
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
    for (const button of [projectCancelButton, chatCancelButton]) {
      button.disabled = !activeTaskId;
    }
    const receivedResult = await readEventStream(response);
    if (!receivedResult) {
      throw new Error("The task stream ended before the agent returned a result.");
    }
    if (purpose === "chat") hasDraftChat = false;
    if (purpose === "project") hasDraftProjectConversation = false;
    await refreshContext();
    await refreshChatWorkspace();
    const input = purpose === "chat" ? chatInput : projectTaskInput;
    input.value = "";
    if (purpose === "project") updateProjectTaskCount();
    input.focus();
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

  for (const button of [projectCancelButton, chatCancelButton]) {
    button.disabled = true;
    button.textContent = "Cancelling…";
  }
  projectTaskHint.textContent = "Cancelling the current task. Changes already completed will remain.";
  chatHint.textContent = "Cancelling the current reply.";

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
    projectCancelButton.disabled = false;
    projectCancelButton.textContent = "Cancel task";
    chatCancelButton.disabled = false;
    chatCancelButton.textContent = "Cancel reply";
    addActivity("Could not cancel the task", error.message || "Try again in a moment.", "failed");
  }
}

projectTaskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const task = projectTaskInput.value.trim();
  if (!task) {
    projectTaskInput.focus();
    projectTaskHint.textContent = "Add a short project task description to begin.";
    return;
  }
  runTask(task, "project");
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const task = chatInput.value.trim();
  if (!task) {
    chatInput.focus();
    chatHint.textContent = "Ask a question to start the conversation.";
    return;
  }
  runTask(task, "chat");
});

projectTaskInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    projectTaskForm.requestSubmit();
  }
});

projectTaskInput.addEventListener("input", updateProjectTaskCount);

chatInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

safetyGuard.addEventListener("change", saveSafetyGuardPreference);

runProjectButton.addEventListener("click", toggleProjectRunner);
deleteProjectButton.addEventListener("click", deleteActiveProject);
previewProjectButton.addEventListener("click", (event) => {
  if (previewProjectButton.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
  }
});
downloadProject.addEventListener("click", (event) => {
  if (downloadProject.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
  }
});
projectCancelButton.addEventListener("click", cancelTask);
chatCancelButton.addEventListener("click", cancelTask);
runEvaluationsButton.addEventListener("click", () => runAgentEvaluations());
runLiveEvaluationsButton.addEventListener("click", () => runAgentEvaluations("live"));
publishGitHubButton.addEventListener("click", publishGitHubProject);
clearConversationButton.addEventListener("click", clearProjectConversation);
clearChatButton.addEventListener("click", clearChatConversation);
newChatButton.addEventListener("click", startNewChat);
newProjectChatButton.addEventListener("click", startNewProjectConversation);

for (const switcher of workspaceSwitches) {
  switcher.addEventListener("click", () => {
    setWorkspaceView(switcher.dataset.workspaceSwitch);
  });
  switcher.addEventListener("keydown", moveWorkspaceFocus);
}

for (const toggle of document.querySelectorAll("[data-panel-toggle]")) {
  toggle.addEventListener("click", () => {
    const content = document.querySelector(`#${toggle.dataset.panelToggle}`);
    if (!content) return;
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    content.hidden = expanded;
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.textContent = expanded ? "Expand" : "Collapse";
  });
}

for (const suggestion of document.querySelectorAll("[data-prompt]")) {
  suggestion.addEventListener("click", () => {
    projectTaskInput.value = suggestion.dataset.prompt;
    updateProjectTaskCount();
    projectTaskInput.focus();
  });
}

for (const suggestion of document.querySelectorAll("[data-chat-prompt]")) {
  suggestion.addEventListener("click", () => {
    chatInput.value = suggestion.dataset.chatPrompt;
    chatInput.focus();
  });
}

requirementsStarter.addEventListener("click", () => {
  if (requirementsGuide.classList.contains("is-awaiting")) {
    projectTaskInput.focus();
    projectTaskHint.textContent = "Reply in short bullets with the purpose, features, and UI/UX direction.";
    return;
  }
  projectTaskInput.value = "Create an app";
  updateProjectTaskCount();
  projectTaskInput.focus();
  projectTaskHint.textContent = "Run this to start a short requirements conversation before any project files are created.";
});

function updateCosmicParallax() {
  if (!cosmicBackdrop) return;
  const offset = Math.min(window.scrollY * 0.16, 180);
  cosmicBackdrop.style.setProperty("--scroll-offset", `${offset}px`);
}

let cosmicFrame = null;
window.addEventListener("scroll", () => {
  if (cosmicFrame !== null) return;
  cosmicFrame = window.requestAnimationFrame(() => {
    updateCosmicParallax();
    cosmicFrame = null;
  });
}, { passive: true });

updateCosmicParallax();

restoreSafetyGuardPreference();
restoreActiveChatId();
restoreActiveProjectConversationId();
restoreWorkspaceView();
updateProjectTaskCount();
setRunning(false);
refreshActiveTask({ announce: true, replaceActivity: true });
refreshContext();
refreshChatWorkspace();
refreshAgentEvaluation();
refreshTaskHistory();
refreshGitHubStatus();
