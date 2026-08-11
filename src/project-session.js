const MAX_TURNS = 3;
const MAX_TASK_CHARS = 1_200;
const MAX_OUTCOME_CHARS = 1_600;

function boundedText(value, maximumLength) {
    if (typeof value !== "string") {
        return null;
    }

    const text = value.trim().replace(/\0/g, "");
    return text ? text.slice(0, maximumLength) : null;
}

/**
 * Keeps a small, process-local conversation thread for each generated project.
 * It intentionally has no disk backing: task prompts and agent responses remain
 * out of the private SQLite history and disappear when the dashboard restarts.
 */
export default class ProjectSession {
    constructor({ maxTurns = MAX_TURNS } = {}) {
        this.maxTurns = maxTurns;
        this.sessions = new Map();
    }

    recent(project) {
        if (typeof project !== "string" || !project) {
            return [];
        }

        return (this.sessions.get(project) || []).map((turn) => ({ ...turn }));
    }

    record(project, { task, outcome } = {}) {
        if (typeof project !== "string" || !project || project.includes("\0")) {
            return;
        }

        const safeTask = boundedText(task, MAX_TASK_CHARS);
        const safeOutcome = boundedText(outcome, MAX_OUTCOME_CHARS);

        if (!safeTask || !safeOutcome) {
            return;
        }

        const turns = this.sessions.get(project) || [];
        turns.push({ task: safeTask, outcome: safeOutcome });
        this.sessions.set(project, turns.slice(-this.maxTurns));
    }
}
