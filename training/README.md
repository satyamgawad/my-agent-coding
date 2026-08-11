# Fine-tuning the coding agent

This folder prepares **reviewed examples**, not raw chats or private project
files, for a LoRA fine-tuning job. It does not launch GPU training from the
agent dashboard.

## Workflow

1. Add manually reviewed examples to `examples/agent-tool-calls.jsonl`.
   Each line is one JSON object using conversational `messages`; assistant tool
   actions use native `tool_calls`. Keep the system prompt and tools aligned
   with this agent's safety rules.
2. Keep 10–20% of examples out of training. Add those unseen checks to
   `evaluations/agent-tool-calls.jsonl`.
3. Validate and sanitize the training data:

   ```bash
   npm run prepare:finetune
   ```

   The command rejects malformed records and unknown tool calls, normalizes
   tools to this agent's registered set, and redacts common keys, tokens, and
   passwords. Review the generated file before uploading it.
4. Upload `training/build/agent-tool-calls.ready.jsonl` and its separate
   validation split to a NeMo Customizer workspace. Start with a compatible
   trainable open-weight model and a LoRA supervised fine-tuning job—not a
   full-weight run. Use NVIDIA's current model catalog and LoRA tutorial to
   select the exact base model and training parameters for your environment.
5. Deploy the resulting adapter/model through NVIDIA NIM. Set
   `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`, and `NVIDIA_MODEL` in this
   project's private `.env`. Choose **Fine-tuned** in the dashboard to run the
   custom model alone, or **Smart** to run that custom model with the planning
   and review workflow.
6. Evaluate the deployed model against the held-out checks:

   ```bash
   FINETUNE_MODEL=your-workspace/your-finetuned-model npm run evaluate:finetune
   ```

   Do not replace the normal agent route unless it meets or exceeds the base
   model on the hold-out set and normal safety tests.

## Data standard

- Teach observed behavior: correct tool selection, safe refusals, verification,
  repair after tests fail, and concise final reports.
- Do not use hidden reasoning, raw conversation storage, credentials, private
  source, or unreviewed model output as training data.
- Start with one narrow behavior and 100+ high-quality examples. Measure that
  behavior before adding more data.

See NVIDIA's [dataset-format guide](https://docs.nvidia.com/nemo-platform/documentation/customizer-reference/tutorials/format-training-dataset)
and [LoRA customization tutorial](https://docs.nvidia.com/nemo-platform/v0.2.0/documentation/customizer-reference/tutorials/lora-customization-job)
for NeMo environment setup and job submission.
