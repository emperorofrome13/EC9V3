# Deprecated Task Verify Stage

This stage is deprecated. New AutoPrompt runs map `task_verify` to the final `completeness` stage before loading prompts.

If this file is loaded directly by a legacy path, perform the same mission as completeness:

- Compare the final implementation against the original request.
- Inspect actual files and behavior.
- Fix missing required functionality when possible.
- Verify again after changes.
- Return only the structured JSON object required by the system message.

Original request:
{requirements}

Latest assistant/project context:
{context}

Prior unresolved issues:
{errors}
