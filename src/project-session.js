import fs from "node:fs";
import path from "node:path";

const DATA_DIRECTORY = ".agent-data";
const SESSIONS_DIRECTORY = "project-conversations";
const MAX_TURNS = 12;
const MAX_TASK_CHARS = 1_200;
const MAX_OUTCOME_CHARS = 1_600;
const MAX_FILE_BYTES = 128 * 1024;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*([:=])\s*([^\s,;]+)/gi;

function sessionError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function safeProject(project) {
    return typeof project === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)
        ? project
        : null;
}

function boundedText(value, maximumLength) {
    if (typeof value !== "string") {
        return null;
    }

    const text = value
        .trim()
        .replace(/\0/g, "")
        .replace(SECRET_ASSIGNMENT, (_match, name, operator) => `${name}${operator}[REDACTED]`);
    return text ? text.slice(0, maximumLength) : null;
}

function copyTurn(turn) {
    return {
        task: turn.task,
        outcome: turn.outcome,
        completedAt: turn.completedAt,
    };
}

function validTurn(turn) {
    return turn &&
        typeof turn === "object" &&
        typeof turn.task === "string" &&
        typeof turn.outcome === "string" &&
        typeof turn.completedAt === "string";
}

/**
 * Stores a small, project-scoped conversation transcript outside generated
 * source. It contains only the user's task and the final agent outcome—never
 * hidden reasoning or tool output—and stays bounded so later prompts remain
 * focused. A caller can omit workspaceManager for short-lived in-memory use.
 */
export default class ProjectSession {
    constructor({ workspaceManager, maxTurns = MAX_TURNS, now = () => new Date() } = {}) {
        this.workspaceManager = workspaceManager || null;
        this.maxTurns = maxTurns;
        this.now = now;
        this.sessions = new Map();
    }

    resolveDirectory() {
        if (!this.workspaceManager) {
            return null;
        }

        const projectsRoot = this.workspaceManager.resolveProjectsRoot({ create: true });
        const dataDirectory = path.join(projectsRoot, DATA_DIRECTORY);
        const directory = path.join(dataDirectory, SESSIONS_DIRECTORY);

        if (!isInside(projectsRoot, directory)) {
            throw sessionError("Conversation storage is outside the projects directory.", "SESSION_OUTSIDE_PROJECTS");
        }

        for (const candidate of [dataDirectory, directory]) {
            if (!fs.existsSync(candidate)) {
                fs.mkdirSync(candidate);
            }

            const details = fs.lstatSync(candidate);

            if (!details.isDirectory() || details.isSymbolicLink()) {
                throw sessionError("Conversation storage must be a local directory.", "SESSION_UNSAFE_DIRECTORY");
            }
        }

        const resolvedDirectory = fs.realpathSync(directory);

        if (!isInside(projectsRoot, resolvedDirectory)) {
            throw sessionError("Conversation storage resolves outside the projects directory.", "SESSION_OUTSIDE_PROJECTS");
        }

        return resolvedDirectory;
    }

    filePath(project) {
        const safe = safeProject(project);

        if (!safe) {
            return null;
        }

        const directory = this.resolveDirectory();
        return directory ? path.join(directory, `${safe}.json`) : null;
    }

    readStored(project) {
        const filePath = this.filePath(project);

        if (!filePath) {
            return (this.sessions.get(project) || []).map(copyTurn);
        }

        if (!fs.existsSync(filePath)) {
            return [];
        }

        const details = fs.lstatSync(filePath);

        if (!details.isFile() || details.isSymbolicLink()) {
            throw sessionError("Conversation storage must be a local file.", "SESSION_UNSAFE_FILE");
        }

        if (details.size > MAX_FILE_BYTES) {
            throw sessionError("Conversation history is too large to load safely.", "SESSION_TOO_LARGE");
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));

            if (!Array.isArray(parsed)) {
                throw new Error("Conversation must be an array.");
            }

            return parsed
                .filter(validTurn)
                .map((turn) => ({
                    task: boundedText(turn.task, MAX_TASK_CHARS),
                    outcome: boundedText(turn.outcome, MAX_OUTCOME_CHARS),
                    completedAt: boundedText(turn.completedAt, 80),
                }))
                .filter((turn) => turn.task && turn.outcome && turn.completedAt)
                .slice(-this.maxTurns);
        } catch {
            throw sessionError("Conversation history is not valid local data.", "SESSION_INVALID");
        }
    }

    writeStored(project, turns) {
        const filePath = this.filePath(project);

        if (!filePath) {
            this.sessions.set(project, turns.map(copyTurn));
            return;
        }

        const temporaryPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;

        try {
            fs.writeFileSync(temporaryPath, `${JSON.stringify(turns, null, 2)}\n`, { mode: 0o600 });
            fs.renameSync(temporaryPath, filePath);
        } finally {
            if (fs.existsSync(temporaryPath)) {
                fs.rmSync(temporaryPath, { force: true });
            }
        }
    }

    recent(project) {
        if (!safeProject(project)) {
            return [];
        }

        return this.readStored(project).map(copyTurn);
    }

    record(project, { task, outcome } = {}) {
        if (!safeProject(project)) {
            return [];
        }

        const safeTask = boundedText(task, MAX_TASK_CHARS);
        const safeOutcome = boundedText(outcome, MAX_OUTCOME_CHARS);

        if (!safeTask || !safeOutcome) {
            return this.recent(project);
        }

        const turns = this.recent(project);
        const updated = [
            ...turns,
            {
                task: safeTask,
                outcome: safeOutcome,
                completedAt: this.now().toISOString(),
            },
        ].slice(-this.maxTurns);
        this.writeStored(project, updated);
        return updated.map(copyTurn);
    }

    clear(project) {
        if (!safeProject(project)) {
            return;
        }

        const filePath = this.filePath(project);

        if (!filePath) {
            this.sessions.delete(project);
            return;
        }

        if (!fs.existsSync(filePath)) {
            return;
        }

        const details = fs.lstatSync(filePath);

        if (!details.isFile() || details.isSymbolicLink()) {
            throw sessionError("Conversation storage must be a local file.", "SESSION_UNSAFE_FILE");
        }

        fs.rmSync(filePath);
    }
}
