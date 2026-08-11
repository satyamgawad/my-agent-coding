import fs from "node:fs";
import path from "node:path";

const DATA_DIRECTORY = ".agent-data";
const BRIEFS_DIRECTORY = "project-briefs";
const BRIEF_VERSION = 1;
const MAX_FILE_BYTES = 24 * 1024;
const MAX_GOAL_CHARS = 1_200;
const MAX_PLAN_CHARS = 3_600;
const MAX_OUTCOME_CHARS = 1_600;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*([:=])\s*([^\s,;]+)/gi;

function briefError(message, code) {
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

function cleanText(value, maximumLength) {
    if (typeof value !== "string") {
        return null;
    }

    const text = value
        .trim()
        .replace(/\0/g, "")
        .replace(SECRET_ASSIGNMENT, (_match, name, operator) => `${name}${operator}[REDACTED]`);
    return text ? text.slice(0, maximumLength) : null;
}

function publicBrief(brief) {
    return {
        state: "ready",
        project: brief.project,
        goal: brief.goal,
        plan: brief.plan,
        outcome: brief.outcome,
        updatedAt: brief.updatedAt,
        message: "Saved Smart mode brief is available for the next project task.",
    };
}

function validBrief(brief, project) {
    return brief &&
        typeof brief === "object" &&
        !Array.isArray(brief) &&
        brief.version === BRIEF_VERSION &&
        brief.project === project &&
        Boolean(cleanText(brief.goal, MAX_GOAL_CHARS)) &&
        Boolean(cleanText(brief.plan, MAX_PLAN_CHARS)) &&
        Boolean(cleanText(brief.outcome, MAX_OUTCOME_CHARS)) &&
        Boolean(cleanText(brief.updatedAt, 80));
}

/**
 * Stores a compact, high-level Smart mode handoff outside generated source.
 * It is deliberately distinct from the chat transcript and never contains
 * tool output or hidden reasoning.
 */
export default class ProjectBrief {
    constructor({ workspaceManager, now = () => new Date() } = {}) {
        if (!workspaceManager) {
            throw new TypeError("Project brief needs a workspace manager.");
        }

        this.workspaceManager = workspaceManager;
        this.now = now;
    }

    resolveDirectory() {
        const projectsRoot = this.workspaceManager.resolveProjectsRoot({ create: true });
        const dataDirectory = path.join(projectsRoot, DATA_DIRECTORY);
        const directory = path.join(dataDirectory, BRIEFS_DIRECTORY);

        if (!isInside(projectsRoot, directory)) {
            throw briefError("Project brief storage is outside the projects directory.", "BRIEF_OUTSIDE_PROJECTS");
        }

        for (const candidate of [dataDirectory, directory]) {
            if (!fs.existsSync(candidate)) {
                fs.mkdirSync(candidate);
            }

            const details = fs.lstatSync(candidate);

            if (!details.isDirectory() || details.isSymbolicLink()) {
                throw briefError("Project brief storage must be a local directory.", "BRIEF_UNSAFE_DIRECTORY");
            }
        }

        const resolvedDirectory = fs.realpathSync(directory);

        if (!isInside(projectsRoot, resolvedDirectory)) {
            throw briefError("Project brief storage resolves outside the projects directory.", "BRIEF_OUTSIDE_PROJECTS");
        }

        return resolvedDirectory;
    }

    activeTarget() {
        const project = safeProject(this.workspaceManager.getContext().project);

        if (!project) {
            return null;
        }

        return {
            project,
            filePath: path.join(this.resolveDirectory(), `${project}.json`),
        };
    }

    read() {
        const target = this.activeTarget();

        if (!target) {
            return {
                state: "idle",
                project: null,
                goal: null,
                plan: null,
                outcome: null,
                updatedAt: null,
                message: "Select a project to use its Smart mode brief.",
            };
        }

        if (!fs.existsSync(target.filePath)) {
            return {
                state: "idle",
                project: target.project,
                goal: null,
                plan: null,
                outcome: null,
                updatedAt: null,
                message: "No saved Smart mode brief for this project yet.",
            };
        }

        const details = fs.lstatSync(target.filePath);

        if (!details.isFile() || details.isSymbolicLink()) {
            throw briefError("Project brief storage must be a local file.", "BRIEF_UNSAFE_FILE");
        }

        if (details.size > MAX_FILE_BYTES) {
            throw briefError("Project brief is too large to load safely.", "BRIEF_TOO_LARGE");
        }

        let parsed;

        try {
            parsed = JSON.parse(fs.readFileSync(target.filePath, "utf8"));
        } catch {
            throw briefError("Project brief is not valid local data.", "BRIEF_INVALID");
        }

        if (!validBrief(parsed, target.project)) {
            throw briefError("Project brief is not valid local data.", "BRIEF_INVALID");
        }

        return publicBrief({
            project: target.project,
            goal: cleanText(parsed.goal, MAX_GOAL_CHARS),
            plan: cleanText(parsed.plan, MAX_PLAN_CHARS),
            outcome: cleanText(parsed.outcome, MAX_OUTCOME_CHARS),
            updatedAt: cleanText(parsed.updatedAt, 80),
        });
    }

    save({ goal, plan, outcome } = {}) {
        const target = this.activeTarget();

        if (!target) {
            return this.read();
        }

        const brief = {
            version: BRIEF_VERSION,
            project: target.project,
            goal: cleanText(goal, MAX_GOAL_CHARS),
            plan: cleanText(plan, MAX_PLAN_CHARS),
            outcome: cleanText(outcome, MAX_OUTCOME_CHARS),
            updatedAt: this.now().toISOString(),
        };

        if (!validBrief(brief, target.project)) {
            throw briefError("A Smart mode brief needs a goal, plan, and outcome.", "BRIEF_INVALID");
        }

        const temporaryPath = `${target.filePath}.${process.pid}-${Date.now()}.tmp`;

        try {
            fs.writeFileSync(temporaryPath, `${JSON.stringify(brief, null, 2)}\n`, { mode: 0o600 });
            fs.renameSync(temporaryPath, target.filePath);
        } finally {
            if (fs.existsSync(temporaryPath)) {
                fs.rmSync(temporaryPath, { force: true });
            }
        }

        return publicBrief(brief);
    }
}
