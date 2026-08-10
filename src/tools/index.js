import { createFileTools } from "./files.js";
import { createProjectTreeTool } from "./project.js";
import { createProjectTools } from "./projects.js";
import { createTerminalTool } from "./terminal.js";
import { createTestTool } from "./test.js";
import { ALLOWED_TERMINAL_COMMANDS, TOOL_ARGUMENT_SCHEMAS } from "./validation.js";
import LearningMemory from "../learning-memory.js";
import { ProjectEvaluator } from "../project-intelligence.js";
import ProjectPlan from "../project-plan.js";

const SOURCE_ONLY_TOOLS = new Set([
    "readAgentSource",
    "writeAgentSource",
    "editAgentSource",
    "testAgentSource",
]);

export const TOOL_DEFINITIONS = {
    createProject: {
        description:
            "Create and select a new isolated project in the agent's projects directory.",
        arguments: { name: "string" },
    },
    listProjects: {
        description: "List available generated projects.",
        arguments: {},
    },
    selectProject: {
        description: "Select an existing generated project as the active workspace.",
        arguments: { name: "string" },
    },
    listFiles: {
        description: "List unprotected files and folders in the active project.",
        arguments: { directory: "string" },
    },
    readFile: {
        description: "Read an existing file in the active project.",
        arguments: { filePath: "string" },
    },
    writeFile: {
        description: "Create or replace a file in the active project.",
        arguments: { filePath: "string", content: "string" },
    },
    editFile: {
        description:
            "Safely replace exact text in an existing file. It rejects missing and ambiguous oldText.",
        arguments: {
            filePath: "string",
            oldText: "string",
            newText: "string",
            replaceAll: "boolean (optional)",
        },
    },
    projectTree: {
        description: "Recursively show the active project's unprotected file structure.",
        arguments: { directory: "string" },
    },
    projectReadiness: {
        description: "Evaluate the active project's deterministic implementation, manifest, test, and documentation readiness checks.",
        arguments: {},
    },
    createProjectPlan: {
        description: "Save a private milestone plan for a large active project. Milestones need lowercase-hyphen ids, titles, optional descriptions, and optional dependencies on earlier milestone ids.",
        arguments: { goal: "string", milestones: "array of milestone objects" },
    },
    readProjectPlan: {
        description: "Read the active project's private saved milestone plan and progress.",
        arguments: {},
    },
    updateMilestone: {
        description: "Update one saved milestone's status: pending, in_progress, blocked, or completed. Dependencies must complete before in_progress or completed.",
        arguments: { id: "string", status: "string", notes: "string (optional)" },
    },
    terminal: {
        description: `Run one allowlisted development command in the active project: ${ALLOWED_TERMINAL_COMMANDS.join(", ")}.`,
        arguments: { command: "string" },
    },
    test: {
        description: "Run npm test in the active project.",
        arguments: {},
    },
    rememberLesson: {
        description: "Store one short, non-secret reusable lesson for related future tasks on this local agent.",
        arguments: { lesson: "string", tags: "string (optional)" },
    },
    readAgentSource: {
        description: "Read a safe agent source file. Available only for an explicit self-improvement task.",
        arguments: { filePath: "string" },
    },
    writeAgentSource: {
        description: "Create or replace an allowed non-security-critical agent source file. Available only for an explicit self-improvement task.",
        arguments: { filePath: "string", content: "string" },
    },
    editAgentSource: {
        description: "Safely replace exact text in an allowed non-security-critical agent source file. Available only for an explicit self-improvement task.",
        arguments: {
            filePath: "string",
            oldText: "string",
            newText: "string",
            replaceAll: "boolean (optional)",
        },
    },
    testAgentSource: {
        description: "Run npm test for the coding agent source. Available only after an explicit self-improvement change.",
        arguments: {},
    },
};

export function createTools(workspaceManager, { learningMemory } = {}) {
    const files = createFileTools(workspaceManager);
    const projects = createProjectTools(workspaceManager);
    const memory = learningMemory ?? new LearningMemory({ workspaceManager });
    const projectEvaluator = new ProjectEvaluator(workspaceManager);
    const projectPlan = new ProjectPlan({ workspaceManager });

    const tools = {
        createProject: {
            description: TOOL_DEFINITIONS.createProject.description,
            execute: projects.createProject,
        },
        listProjects: {
            description: TOOL_DEFINITIONS.listProjects.description,
            execute: projects.listProjects,
        },
        selectProject: {
            description: TOOL_DEFINITIONS.selectProject.description,
            execute: projects.selectProject,
        },
        listFiles: {
            description: TOOL_DEFINITIONS.listFiles.description,
            execute: files.listFiles,
        },
        readFile: {
            description: TOOL_DEFINITIONS.readFile.description,
            execute: files.readFile,
        },
        writeFile: {
            description: TOOL_DEFINITIONS.writeFile.description,
            execute: files.writeFile,
        },
        editFile: {
            description: TOOL_DEFINITIONS.editFile.description,
            execute: files.editFile,
        },
        projectTree: {
            description: TOOL_DEFINITIONS.projectTree.description,
            execute: createProjectTreeTool(workspaceManager),
        },
        projectReadiness: {
            description: TOOL_DEFINITIONS.projectReadiness.description,
            execute: () => projectEvaluator.evaluate(),
        },
        createProjectPlan: {
            description: TOOL_DEFINITIONS.createProjectPlan.description,
            execute: (argumentsValue) => projectPlan.create(argumentsValue),
        },
        readProjectPlan: {
            description: TOOL_DEFINITIONS.readProjectPlan.description,
            execute: () => projectPlan.read(),
        },
        updateMilestone: {
            description: TOOL_DEFINITIONS.updateMilestone.description,
            execute: (argumentsValue) => projectPlan.update(argumentsValue),
        },
        terminal: {
            description: TOOL_DEFINITIONS.terminal.description,
            execute: createTerminalTool(workspaceManager),
        },
        test: {
            description: TOOL_DEFINITIONS.test.description,
            execute: createTestTool(workspaceManager),
        },
        rememberLesson: {
            description: TOOL_DEFINITIONS.rememberLesson.description,
            execute: (argumentsValue) => memory.remember(argumentsValue),
        },
    };

    const registered = Object.keys(tools).sort();
    const schemas = Object.keys(TOOL_ARGUMENT_SCHEMAS)
        .filter((name) => !SOURCE_ONLY_TOOLS.has(name))
        .sort();

    if (registered.join(",") !== schemas.join(",")) {
        throw new Error("Tool registry and argument schemas are out of sync.");
    }

    return tools;
}
