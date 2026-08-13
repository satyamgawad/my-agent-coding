import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createSandbox } from "./sandbox.js";

const PREVIEW_CANDIDATES = ["public/index.html", "index.html"];
const PAGE_TIMEOUT_MS = 15_000;
const VIEWPORTS = [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
];

function visualError(message, code = "VISUAL_CHECK_FAILED") {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function contentType(filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".html": return "text/html; charset=utf-8";
        case ".css": return "text/css; charset=utf-8";
        case ".js":
        case ".mjs": return "text/javascript; charset=utf-8";
        case ".json": return "application/json; charset=utf-8";
        case ".svg": return "image/svg+xml";
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".gif": return "image/gif";
        case ".webp": return "image/webp";
        case ".woff2": return "font/woff2";
        default: return "application/octet-stream";
    }
}

function previewEntry(sandbox) {
    for (const candidate of PREVIEW_CANDIDATES) {
        try {
            const fullPath = sandbox.safePath(candidate);
            const details = fs.lstatSync(fullPath);
            if (!details.isSymbolicLink() && details.isFile()) {
                return { relativePath: candidate, fullPath };
            }
        } catch {
            // A project can have either a root page or a public page. Keep
            // looking without exposing filesystem paths outside its workspace.
        }
    }

    throw visualError("Visual checks need a safe public/index.html or index.html page.", "VISUAL_ENTRY_NOT_FOUND");
}

function requestedAsset(requestPath) {
    let decoded;

    try {
        decoded = decodeURIComponent(requestPath || "/");
    } catch {
        return null;
    }

    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const segments = relative.split("/");

    if (!relative || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) {
        return null;
    }

    return segments.join(path.sep);
}

async function startStaticPreview(root) {
    const server = createServer((request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { "cache-control": "no-store" });
            response.end();
            return;
        }

        const relative = requestedAsset(new URL(request.url || "/", "http://127.0.0.1").pathname);
        if (!relative) {
            response.writeHead(404, { "cache-control": "no-store" });
            response.end();
            return;
        }

        const candidate = path.resolve(root, relative);
        if (!isInside(root, candidate)) {
            response.writeHead(404, { "cache-control": "no-store" });
            response.end();
            return;
        }

        try {
            const details = fs.lstatSync(candidate);
            if (!details.isFile() || details.isSymbolicLink()) throw new Error("unsafe asset");
            response.writeHead(200, {
                "content-type": contentType(candidate),
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
            });
            if (request.method === "HEAD") {
                response.end();
                return;
            }
            fs.createReadStream(candidate).pipe(response);
        } catch {
            response.writeHead(404, { "cache-control": "no-store" });
            response.end();
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        await new Promise((resolve) => server.close(resolve));
        throw visualError("The isolated visual preview could not start.", "VISUAL_PREVIEW_UNAVAILABLE");
    }

    return {
        url: `http://127.0.0.1:${address.port}/`,
        async close() {
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

async function inspectViewport(page, viewport) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(80);

    const snapshot = await page.evaluate(() => {
        const labels = [...document.querySelectorAll("input, textarea, select")]
            .filter((control) => control.type !== "hidden")
            .filter((control) => {
                if (control.labels?.length) return false;
                const identifier = control.getAttribute("id");
                return !identifier || !document.querySelector(`label[for="${CSS.escape(identifier)}"]`);
            });
        const imagesWithoutAlt = [...document.images].filter((image) => !image.hasAttribute("alt"));

        return {
            title: document.title.trim(),
            headings: document.querySelectorAll("h1").length,
            landmarks: document.querySelectorAll("main, [role=main]").length,
            controls: document.querySelectorAll("button, a[href], input, textarea, select").length,
            unlabeledInputs: labels.length,
            imagesWithoutAlt: imagesWithoutAlt.length,
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
    });

    const screenshotPath = path.join(os.tmpdir(), `my-agent-visual-${process.pid}-${Date.now()}-${viewport.name}.png`);
    try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        snapshot.screenshotBytes = fs.statSync(screenshotPath).size;
    } finally {
        fs.rmSync(screenshotPath, { force: true });
    }

    return { viewport: viewport.name, ...snapshot };
}

export function createVisualTool(workspaceManager) {
    const sandbox = createSandbox(() => workspaceManager.getActiveWorkspace());

    return async function visualCheck(_arguments = {}, { signal } = {}) {
        if (signal?.aborted) throw signal.reason || new Error("Visual check cancelled.");

        const entry = previewEntry(sandbox);
        const root = path.dirname(entry.fullPath);
        const preview = await startStaticPreview(root);
        const consoleErrors = [];
        const pageErrors = [];
        let browser;

        try {
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage({ viewport: VIEWPORTS[0] });
            const allowedOrigin = new URL(preview.url).origin;

            await page.route("**/*", (route) => {
                try {
                    const requested = new URL(route.request().url());
                    if (requested.origin === allowedOrigin) {
                        return route.continue();
                    }
                } catch {
                    // Block malformed and non-http requests as well.
                }
                return route.abort();
            });
            page.on("console", (message) => {
                if (message.type() === "error" && consoleErrors.length < 8) {
                    consoleErrors.push(message.text().slice(0, 500));
                }
            });
            page.on("pageerror", (error) => {
                if (pageErrors.length < 8) pageErrors.push(String(error.message || error).slice(0, 500));
            });

            await page.goto(preview.url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT_MS });
            const viewports = [];
            for (const viewport of VIEWPORTS) {
                if (signal?.aborted) throw signal.reason || new Error("Visual check cancelled.");
                viewports.push(await inspectViewport(page, viewport));
            }

            const desktop = viewports[0];
            const checks = [
                { label: "Page title", status: desktop.title ? "pass" : "warn" },
                { label: "Primary heading", status: desktop.headings > 0 ? "pass" : "warn" },
                { label: "Main landmark", status: desktop.landmarks > 0 ? "pass" : "warn" },
                { label: "Form labels", status: viewports.every((view) => view.unlabeledInputs === 0) ? "pass" : "warn" },
                { label: "Image text alternatives", status: viewports.every((view) => view.imagesWithoutAlt === 0) ? "pass" : "warn" },
                { label: "Responsive width", status: viewports.every((view) => !view.horizontalOverflow) ? "pass" : "warn" },
                { label: "Browser errors", status: consoleErrors.length === 0 && pageErrors.length === 0 ? "pass" : "fail" },
            ];
            const failed = checks.filter((check) => check.status === "fail");
            const warnings = checks.filter((check) => check.status === "warn");

            return {
                state: failed.length > 0 ? "needs-attention" : "ready",
                entryPath: entry.relativePath,
                checks,
                viewports,
                consoleErrors,
                pageErrors,
                message: failed.length > 0
                    ? "The browser found runtime errors. Repair them before delivery."
                    : warnings.length > 0
                        ? "Browser screenshots and responsive checks completed with a few quality warnings."
                        : "Browser screenshots and responsive checks completed cleanly.",
            };
        } catch (error) {
            if (/Executable doesn't exist|browserType\.launch/i.test(String(error?.message || error))) {
                throw visualError("Playwright Chromium is unavailable. Install the browser before running visual checks.", "VISUAL_BROWSER_UNAVAILABLE");
            }
            throw error;
        } finally {
            await browser?.close().catch(() => {});
            await preview.close().catch(() => {});
        }
    };
}
