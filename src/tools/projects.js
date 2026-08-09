export function createProjectTools(workspaceManager) {
    return {
        createProject({ name }) {
            return workspaceManager.createProject(name);
        },

        listProjects() {
            return workspaceManager.listProjects();
        },

        selectProject({ name }) {
            return workspaceManager.selectProject(name);
        },
    };
}
