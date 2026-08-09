import fs from "node:fs";
import path from "node:path";

function workspaceError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

export function projectSlug(name) {
    if (typeof name !== "string" || !name.trim()) {
        throw workspaceError(
            "A non-empty project name is required.",
            "INVALID_PROJECT_NAME"
        );
    }

    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (!slug || slug.length > 64) {
        throw workspaceError(
            "Project names must produce a 1-64 character lowercase slug.",
            "INVALID_PROJECT_NAME"
        );
    }

    return slug;
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function nearestExistingPath(target) {
    let candidate = target;

    while (!fs.existsSync(candidate)) {
        const parent = path.dirname(candidate);

        if (parent === candidate) {
            break;
        }

        candidate = parent;
    }

    return fs.realpathSync(candidate);
}

export default class WorkspaceManager {
    constructor({ agentRoot = process.cwd(), projectsDirectory = "projects" } = {}) {
        this.agentRoot = fs.realpathSync(agentRoot);
        this.projectsRoot = path.resolve(this.agentRoot, projectsDirectory);

        if (!isInside(this.agentRoot, this.projectsRoot)) {
            throw workspaceError(
                "The projects directory must be inside the agent directory.",
                "INVALID_PROJECTS_DIRECTORY"
            );
        }

        this.activeProject = null;
    }

    resolveProjectsRoot({ create = false } = {}) {
        const existingPath = nearestExistingPath(this.projectsRoot);

        if (!isInside(this.agentRoot, existingPath)) {
            throw workspaceError(
                "Access denied: the projects directory resolves outside the agent directory.",
                "PROJECTS_ROOT_OUTSIDE_AGENT"
            );
        }

        if (!fs.existsSync(this.projectsRoot)) {
            if (!create) {
                return null;
            }

            fs.mkdirSync(this.projectsRoot, { recursive: true });
        }

        const resolvedRoot = fs.realpathSync(this.projectsRoot);

        if (!isInside(this.agentRoot, resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
            throw workspaceError(
                "Access denied: the projects directory must be a directory inside the agent directory.",
                "PROJECTS_ROOT_OUTSIDE_AGENT"
            );
        }

        return resolvedRoot;
    }

    resolveProjectWorkspace(project, projectsRoot = this.resolveProjectsRoot()) {
        if (!projectsRoot) {
            throw workspaceError(
                `Project "${project}" does not exist.`,
                "PROJECT_NOT_FOUND"
            );
        }

        const workspace = path.join(projectsRoot, project);

        if (!fs.existsSync(workspace)) {
            throw workspaceError(
                `Project "${project}" does not exist.`,
                "PROJECT_NOT_FOUND"
            );
        }

        const entry = fs.lstatSync(workspace);

        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw workspaceError(
                "Access denied: project resolves outside the projects directory.",
                "PROJECT_OUTSIDE_ROOT"
            );
        }

        const resolvedWorkspace = fs.realpathSync(workspace);

        if (!isInside(projectsRoot, resolvedWorkspace)) {
            throw workspaceError(
                "Access denied: project resolves outside the projects directory.",
                "PROJECT_OUTSIDE_ROOT"
            );
        }

        return resolvedWorkspace;
    }

    listProjects() {
        const projectsRoot = this.resolveProjectsRoot();

        if (!projectsRoot) {
            return [];
        }

        return fs
            .readdirSync(projectsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .map((entry) => entry.name)
            .sort();
    }

    createProject(name) {
        const project = projectSlug(name);
        const projectsRoot = this.resolveProjectsRoot({ create: true });

        const workspace = path.join(projectsRoot, project);

        if (fs.existsSync(workspace)) {
            throw workspaceError(
                `Project "${project}" already exists. Select it instead of creating it again.`,
                "PROJECT_EXISTS"
            );
        }

        fs.mkdirSync(workspace);
        this.resolveProjectWorkspace(project, projectsRoot);
        this.activeProject = project;

        return this.describeActiveProject();
    }

    selectProject(name) {
        const project = projectSlug(name);
        const projectsRoot = this.resolveProjectsRoot();
        this.resolveProjectWorkspace(project, projectsRoot);

        this.activeProject = project;
        return this.describeActiveProject();
    }

    getActiveWorkspace() {
        if (!this.activeProject) {
            throw workspaceError(
                "No project is selected. Create a project or select an existing project first.",
                "NO_ACTIVE_PROJECT"
            );
        }

        return this.resolveProjectWorkspace(this.activeProject);
    }

    describeActiveProject() {
        const workspace = this.getActiveWorkspace();

        return {
            project: this.activeProject,
            workspace: path.relative(this.agentRoot, workspace) || ".",
        };
    }

    getContext() {
        if (!this.activeProject) {
            return {
                project: null,
                workspace: null,
                projects: this.listProjects(),
            };
        }

        return {
            ...this.describeActiveProject(),
            projects: this.listProjects(),
        };
    }
}
