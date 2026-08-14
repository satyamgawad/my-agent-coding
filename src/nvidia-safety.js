import OpenAI from "openai";
import "dotenv/config";

export const DEFAULT_NVIDIA_SAFETY_MODEL = "nvidia/nemotron-3.5-content-safety";
export const DEFAULT_NVIDIA_SAFETY_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MAX_SAFETY_TEXT_CHARS = 16_000;

function safetyText(value) {
    return String(value || "").slice(0, MAX_SAFETY_TEXT_CHARS);
}

function responseText(content) {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => typeof part?.text === "string" ? part.text : "")
            .filter(Boolean)
            .join("\n");
    }

    return "";
}

function safetyState(content) {
    const normalized = responseText(content).toLowerCase();
    const labeledStates = [...normalized.matchAll(/\b(?:user|response)\s+safety\s*:\s*(safe|unsafe)\b/g)]
        .map((match) => match[1]);

    if (labeledStates.length > 0) {
        return labeledStates.includes("unsafe") ? "unsafe" : "safe";
    }

    if (/\bunsafe\b/.test(normalized) && !/\b(?:no|not)\s+unsafe\b/.test(normalized)) {
        return "unsafe";
    }

    return "safe";
}

export function nvidiaSafetyConfig(environment = process.env) {
    const apiKey = environment.NVIDIA_SAFETY_API_KEY || environment.NVIDIA_API_KEY || "";
    const baseURL = environment.NVIDIA_SAFETY_BASE_URL || environment.NVIDIA_BASE_URL || DEFAULT_NVIDIA_SAFETY_BASE_URL;
    const model = environment.NVIDIA_SAFETY_MODEL || DEFAULT_NVIDIA_SAFETY_MODEL;

    if (!apiKey || typeof baseURL !== "string" || !/^https:\/\/[^\s]+$/i.test(baseURL)) {
        return null;
    }

    return { apiKey, baseURL, model };
}

/**
 * Optional NVIDIA moderation for dashboard requests. A provider failure never
 * blocks the local agent: enabling the guard improves safety, while a 429 or
 * transient outage simply leaves the existing local safeguards in charge.
 */
export default class NvidiaSafety {
    constructor({ client, environment = process.env, model, baseURL, apiKey } = {}) {
        const config = nvidiaSafetyConfig(environment);
        this.model = model || config?.model || DEFAULT_NVIDIA_SAFETY_MODEL;
        this.configured = Boolean(client || config || (apiKey && baseURL));
        this.client = client || (this.configured
            ? new OpenAI({
                apiKey: apiKey || config?.apiKey,
                baseURL: baseURL || config?.baseURL,
            })
            : null);
    }

    async inspect({ prompt, response, signal } = {}) {
        if (!this.client) {
            return { state: "unavailable", allowed: true };
        }

        const messages = [{
            role: "user",
            content: [{
                type: "text",
                text: safetyText(prompt),
            }],
        }];

        if (typeof response === "string" && response.trim()) {
            messages.push({
                role: "assistant",
                content: [{
                    type: "text",
                    text: safetyText(response),
                }],
            });
        }

        try {
            const completion = await this.client.chat.completions.create({
                model: this.model,
                messages,
                max_tokens: 180,
                temperature: 0.01,
                top_p: 0.95,
                extra_body: {
                    chat_template_kwargs: {
                        request_categories: "/categories",
                    },
                },
            }, { signal });
            const state = safetyState(completion.choices?.[0]?.message?.content);
            return { state, allowed: state !== "unsafe" };
        } catch {
            return { state: "unavailable", allowed: true };
        }
    }
}
