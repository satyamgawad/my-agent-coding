import fs from "node:fs";
import path from "node:path";

const DATA_DIRECTORY = ".agent-data";
const PLANS_DIRECTORY = "project-plans";
const PLAN_VERSION = 1;
const MAX_GOAL_LENGTH = 600;
const MAX_MILESTONES = 12;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 800;
const MAX_NOTES_LENGTH = 500;
const MAX_DEPENDENCIES = 8;
const MILESTONE_STATUSES = new Set(["pending", "in_progress", "blocked", "completed"]);

function planError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function text(value, label, maximumLength, { required = true } = {}) {
    if (typeof value !== "string") {
        throw planError(`${label} must be a string.`, "INVALID_PROJECT_PLAN");
    }

    const trimmed = value.trim();

    if (required && !trimmed) {
        throw planError(`${label} must be non-empty.`, "INVALID_PROJECT_PLAN");
    }

    if (trimmed.length > maximumLength || trimmed.includes("\0")) {
        throw planError(`${label} is too long or contains an invalid character.`, "INVALID_PROJECT_PLAN");
    }

    return trimmed;
}

function milestoneId(value) {
    const id = text(value, "Milestone id", 48);

    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        throw planError(
            "Milestone id must use lowercase letters, numbers, and hyphens and begin with a letter.",
            "INVALID_PROJECT_PLAN"
        );
    }

    return id;
}

function dependencies(value, milestoneIds, currentIndex) {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES) {
        throw planError(`Milestone dependencies must be an array of at most ${MAX_DEPENDENCIES} ids.`, "INVALID_PROJECT_PLAN");
    }

    const selected = value.map((dependency) => milestoneId(dependency));

    if (new Set(selected).size !== selected.length) {
        throw planError("Milestone dependencies must not repeat an id.", "INVALID_PROJECT_PLAN");
    }

    for (const dependency of selected) {
        const dependencyIndex = milestoneIds.indexOf(dependency);

        if (dependencyIndex === -1 || dependencyIndex >= currentIndex) {
            throw planError(
                "Each milestone dependency must refer to an earlier milestone in the plan.",
                "INVALID_PROJECT_PLAN"
            );
        }
    }

    return selected;
}

function normalizeMilestones(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MILESTONES) {
        throw planError(`Milestones must contain between 1 and ${MAX_MILESTONES} items.`, "INVALID_PROJECT_PLAN");
    }

    const ids = [];

    return value.map((milestone, index) => {
        if (!milestone || typeof milestone !== "object" || Array.isArray(milestone)) {
            throw planError("Each milestone must be an object.", "INVALID_PROJECT_PLAN");
        }

        const allowed = new Set(["id", "title", "description", "dependsOn"]);

        for (const key of Object.keys(milestone)) {
            if (!allowed.has(key)) {
                throw planError(`Unknown milestone field: ${key}.`, "INVALID_PROJECT_PLAN");
            }
        }

        const id = milestoneId(milestone.id);

        if (ids.includes(id)) {
            throw planError("Milestone ids must be unique.", "INVALID_PROJECT_PLAN");
        }

        const normalized = {
            id,
            title: text(milestone.title, "Milestone title", MAX_TITLE_LENGTH),
            description: milestone.description === undefined
                ? ""
                : text(milestone.description, "Milestone description", MAX_DESCRIPTION_LENGTH, { required: false }),
            dependsOn: dependencies(milestone.dependsOn, ids, index),
            status: "pending",
            notes: "",
        };
        ids.push(id);
        return normalized;
    });
}

function statusFor(milestones) {
    if (milestones.every((milestone) => milestone.status === "completed")) {
        return "completed";
    }

    if (milestones.some((milestone) => milestone.status === "blocked")) {
        return "blocked";
    }

    return "active";
}

function publicPlan(plan) {
    const milestones = plan.milestones.map((milestone) => ({ ...milestone }));
    const completed = milestones.filter((milestone) => milestone.status === "completed").length;

    return {
        state: statusFor(milestones),
        project: plan.project,
        goal: plan.goal,
        version: plan.version,
        updatedAt: plan.updatedAt,
        progress: {
            completed,
            total: milestones.length,
        },
        milestones,
    };
}

function normalizeStoredPlan(plan, project) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
        throw planError("The saved project plan has an unsupported format. Create a replacement plan.", "PROJECT_PLAN_INVALID");
    }

    if (plan.version !== PLAN_VERSION || plan.project !== project || !Array.isArray(plan.milestones)) {
        throw planError("The saved project plan has an unsupported format. Create a replacement plan.", "PROJECT_PLAN_INVALID");
    }

    let milestones;

    try {
        milestones = normalizeMilestones(plan.milestones.map((milestone) => ({
            id: milestone?.id,
            title: milestone?.title,
            description: milestone?.description,
            dependsOn: milestone?.dependsOn,
        })));

        plan.milestones.forEach((milestone, index) => {
            if (!MILESTONE_STATUSES.has(milestone?.status)) {
                throw planError("The saved project plan has an unsupported milestone status.", "PROJECT_PLAN_INVALID");
            }

            milestones[index].status = milestone.status;
            milestones[index].notes = text(
                milestone.notes ?? "",
                "Milestone notes",
                MAX_NOTES_LENGTH,
                { required: false }
            );
        });
    } catch (error) {
        if (error?.code === "PROJECT_PLAN_INVALID") {
            throw error;
        }

        throw planError("The saved project plan has an unsupported format. Create a replacement plan.", "PROJECT_PLAN_INVALID");
    }

    try {
        return {
            version: PLAN_VERSION,
            project,
            goal: text(plan.goal, "Plan goal", MAX_GOAL_LENGTH),
            milestones,
            updatedAt: text(plan.updatedAt, "Plan update time", 80),
        };
    } catch {
        throw planError("The saved project plan has an unsupported format. Create a replacement plan.", "PROJECT_PLAN_INVALID");
    }
}

export default class ProjectPlan {
    constructor({ workspaceManager } = {}) {
        if (!workspaceManager) {
            throw new TypeError("Project plan needs a workspace manager.");
        }

        this.workspaceManager = workspaceManager;
    }

    resolvePlansDirectory() {
        const projectsRoot = this.workspaceManager.resolveProjectsRoot({ create: true });
        const dataDirectory = path.join(projectsRoot, DATA_DIRECTORY);
        const plansDirectory = path.join(dataDirectory, PLANS_DIRECTORY);

        if (!isInside(projectsRoot, plansDirectory)) {
            throw planError("Project plan storage is outside the projects directory.", "PLAN_OUTSIDE_PROJECTS");
        }

        for (const directory of [dataDirectory, plansDirectory]) {
            if (!fs.existsSync(directory)) {
                fs.mkdirSync(directory);
            }

            const details = fs.lstatSync(directory);

            if (!details.isDirectory() || details.isSymbolicLink()) {
                throw planError("Project plan storage must be a local directory.", "PLAN_UNSAFE_DIRECTORY");
            }
        }

        const resolvedDirectory = fs.realpathSync(plansDirectory);

        if (!isInside(projectsRoot, resolvedDirectory)) {
            throw planError("Project plan storage resolves outside the projects directory.", "PLAN_OUTSIDE_PROJECTS");
        }

        return resolvedDirectory;
    }

    activePlanPath() {
        const project = this.workspaceManager.getContext().project;

        if (!project) {
            throw planError("Select a project before managing its plan.", "NO_ACTIVE_PROJECT");
        }

        return {
            project,
            path: path.join(this.resolvePlansDirectory(), `${project}.json`),
        };
    }

    readStoredPlan({ required = false } = {}) {
        const target = this.activePlanPath();

        if (!fs.existsSync(target.path)) {
            if (required) {
                throw planError("Create a project plan before updating milestones.", "PROJECT_PLAN_NOT_FOUND");
            }

            return null;
        }

        const details = fs.lstatSync(target.path);

        if (!details.isFile() || details.isSymbolicLink()) {
            throw planError("Project plan storage must be a local file.", "PLAN_UNSAFE_FILE");
        }

        let plan;

        try {
            plan = JSON.parse(fs.readFileSync(target.path, "utf8"));
        } catch {
            throw planError("The saved project plan is unreadable. Create a replacement plan.", "PROJECT_PLAN_INVALID");
        }

        return normalizeStoredPlan(plan, target.project);
    }

    writeStoredPlan(plan) {
        const target = this.activePlanPath();
        const temporaryPath = path.join(
            path.dirname(target.path),
            `.${target.project}-${process.pid}-${Date.now()}.tmp`
        );

        try {
            fs.writeFileSync(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
            fs.renameSync(temporaryPath, target.path);
        } finally {
            if (fs.existsSync(temporaryPath)) {
                fs.rmSync(temporaryPath, { force: true });
            }
        }
    }

    read() {
        const active = this.activePlanPath();
        const plan = this.readStoredPlan();

        if (!plan) {
            return {
                state: "idle",
                project: active.project,
                goal: null,
                progress: { completed: 0, total: 0 },
                milestones: [],
                message: "No saved project plan. Create milestones before starting a multi-phase project.",
            };
        }

        return {
            ...publicPlan(plan),
            message: "Saved project plan loaded from private local metadata.",
        };
    }

    create({ goal, milestones } = {}) {
        const active = this.activePlanPath();
        const plan = {
            version: PLAN_VERSION,
            project: active.project,
            goal: text(goal, "Plan goal", MAX_GOAL_LENGTH),
            milestones: normalizeMilestones(milestones),
            updatedAt: new Date().toISOString(),
        };

        this.writeStoredPlan(plan);
        return {
            ...publicPlan(plan),
            message: "Saved milestone plan. Start the first unblocked milestone before implementation.",
        };
    }

    update({ id, status, notes } = {}) {
        const plan = this.readStoredPlan({ required: true });
        const milestone = plan.milestones.find((item) => item.id === milestoneId(id));

        if (!milestone) {
            throw planError("That milestone does not exist in the saved project plan.", "MILESTONE_NOT_FOUND");
        }

        if (typeof status !== "string" || !MILESTONE_STATUSES.has(status)) {
            throw planError("Milestone status must be pending, in_progress, blocked, or completed.", "INVALID_MILESTONE_STATUS");
        }

        const incompleteDependencies = milestone.dependsOn.filter((dependency) => {
            return plan.milestones.find((item) => item.id === dependency)?.status !== "completed";
        });

        if (["in_progress", "completed"].includes(status) && incompleteDependencies.length > 0) {
            throw planError(
                `Complete dependencies before starting this milestone: ${incompleteDependencies.join(", ")}.`,
                "MILESTONE_DEPENDENCY_INCOMPLETE"
            );
        }

        const activeDependents = plan.milestones.filter((item) => {
            return item.dependsOn.includes(milestone.id) && ["in_progress", "completed"].includes(item.status);
        });

        if (status !== "completed" && activeDependents.length > 0) {
            throw planError(
                `Cannot reopen this milestone while dependent milestones are active: ${activeDependents.map((item) => item.id).join(", ")}.`,
                "MILESTONE_DEPENDENT_ACTIVE"
            );
        }

        milestone.status = status;
        milestone.notes = notes === undefined
            ? milestone.notes
            : text(notes, "Milestone notes", MAX_NOTES_LENGTH, { required: false });
        plan.updatedAt = new Date().toISOString();
        this.writeStoredPlan(plan);

        return {
            ...publicPlan(plan),
            message: `Updated milestone ${milestone.id} to ${status}.`,
        };
    }
}
