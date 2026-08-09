import { createFileTools } from "./files.js";
import { createProjectTreeTool } from "./project.js";
import { createProjectTools } from "./projects.js";
import { createTerminalTool } from "./terminal.js";
import { createTestTool } from "./test.js";
import { ALLOWED_TERMINAL_COMMANDS, TOOL_ARGUMENT_SCHEMAS } from "./validation.js";

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
    terminal: {
        description: `Run one allowlisted development command in the active project: ${ALLOWED_TERMINAL_COMMANDS.join(", ")}.`,
        arguments: { command: "string" },
    },
    test: {
        description: "Run npm test in the active project.",
        arguments: {},
    },
};

export function createTools(workspaceManager) {
    const files = createFileTools(workspaceManager);
    const projects = createProjectTools(workspaceManager);

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
        terminal: {
            description: TOOL_DEFINITIONS.terminal.description,
            execute: createTerminalTool(workspaceManager),
        },
        test: {
            description: TOOL_DEFINITIONS.test.description,
            execute: createTestTool(workspaceManager),
        },
    };

    const registered = Object.keys(tools).sort();
    const schemas = Object.keys(TOOL_ARGUMENT_SCHEMAS).sort();

    if (registered.join(",") !== schemas.join(",")) {
        throw new Error("Tool registry and argument schemas are out of sync.");
    }

    return tools;
}
