# Satyam's Agent for VS Code

This companion extension connects Visual Studio Code to the local My Coding
Agent dashboard already running on your computer. It uses the same selected
project and saved agent conversation as the browser workspace.

## Install locally

1. From the repository root, start the dashboard with `npm run ui`.
2. In this folder, package the extension:

   ```bash
   npx @vscode/vsce package
   ```

3. In VS Code, run **Extensions: Install from VSIX...** and choose the `.vsix`
   file that was created here.
4. Run **Satyam's Agent: Open Agent Panel** from the Command Palette.

The extension points to `http://127.0.0.1:3333` by default. Change
`satyamsAgent.dashboardUrl` in VS Code Settings when the dashboard uses a
different address. If your dashboard has `AGENT_UI_PASSWORD` configured, run
**Satyam's Agent: Set Dashboard Password**. VS Code stores it in SecretStorage,
not normal settings or the webview.

## Included commands

- **Open Agent Panel** — submit a task and watch live task events.
- **Select Project** — switch the shared dashboard project safely.
- **Open Dashboard in Browser** — open the complete browser workspace.
- **Set Dashboard Password** — save or remove the private dashboard password.

The extension does not contain an API key, starts no separate agent server, and
does not put task prompts or dashboard passwords in VS Code settings.
