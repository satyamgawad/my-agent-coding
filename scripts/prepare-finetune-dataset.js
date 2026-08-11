import process from "node:process";
import { readFineTuneJsonl, writeFineTuneJsonl } from "../src/finetuning-data.js";

const [inputPath = "training/examples/agent-tool-calls.jsonl", outputPath = "training/build/agent-tool-calls.ready.jsonl"] = process.argv.slice(2);

try {
    const records = readFineTuneJsonl(inputPath);
    const result = writeFineTuneJsonl(records, outputPath);
    console.log(`Prepared ${result.records} validated records at ${result.filePath}`);
} catch (error) {
    console.error(`Could not prepare fine-tuning data: ${error.message}`);
    process.exitCode = 1;
}
