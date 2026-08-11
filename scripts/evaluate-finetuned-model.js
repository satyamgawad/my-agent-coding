import fs from "node:fs";
import process from "node:process";
import { createFineTuneClient, evaluateFineTunedModel, validateFineTuneEvaluation } from "../src/finetuning-evaluation.js";

const [evaluationPath = "training/evaluations/agent-tool-calls.jsonl"] = process.argv.slice(2);

function readEvaluations(filePath) {
    return fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line, index) => {
            try {
                return validateFineTuneEvaluation(JSON.parse(line));
            } catch (error) {
                throw new Error(`Line ${index + 1}: ${error.message}`);
            }
        });
}

try {
    const model = process.env.FINETUNE_MODEL;
    const result = await evaluateFineTunedModel(readEvaluations(evaluationPath), {
        client: createFineTuneClient(),
        model,
    });
    console.log(`${result.passed}/${result.total} fine-tuned model checks passed (${result.passRate}%).`);
    for (const item of result.results) {
        console.log(`${item.status === "pass" ? "✓" : "✗"} ${item.id}: ${item.summary}`);
    }
    if (result.passed !== result.total) process.exitCode = 1;
} catch (error) {
    console.error(`Could not evaluate the fine-tuned model: ${error.message}`);
    process.exitCode = 1;
}
