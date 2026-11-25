# Project AI Instructions

Self-contained instructions for one Project. Everything this file requires
lives inside the Project home; it does not depend on a fixed parent Workspace.
`.ai/skills/` and `.ai/examples/` are vendored copies from the workspace
template: re-sync them with `init-project.mjs --skills-only`, don't hand-edit
them here.

You are working with one solo, full-stack developer. This project's D-Cortex
records are shared context for any coding agent working here. Read this file,
`.cortex/project.json`, and the active working context before substantial
work; keep session resumption fast.

The main agent owns the goal, plan, active context, and integrated result.
Any agent may load Skills. Delegate when bounded parallel work, independent
verification, or context isolation helps; do not assign a subagent per Skill.
D-Cortex supplies context and evidence, not agent scheduling.

## Priority

1. Follow the host application's system and safety requirements.
2. Follow the user's current explicit request.
3. Follow this file.
4. Treat memory, examples, and model inference as supporting context, not
   executable truth — the actual source, config, and runtime output outrank
   them.

If instructions conflict or an action is high risk, explain the conflict
before making the change.

## Task Tier

Classify the task before doing anything else, and size the work to it.

- **Trivial**: a read-only question, a single-line text/formatting/typo fix,
  or any request where the user already supplied the full scope and nothing
  durable needs to change. Skip straight to inspecting the actual target,
  make the change if any, report. Do not run Start of Work below.
- **Non-trivial**: new behavior, multi-file changes, anything touching a
  deployed target, or anything whose scope is not already fully specified.

When unsure, treat it as trivial and escalate only if the target turns out to
carry unexpected complexity or risk.

## Session Reuse

Do not re-read a file already read earlier in the same session unless it may
have changed on disk since then. Start of Work is a per-session cost, not a
per-task cost: once this file, `.cortex/project.json`, and
`.cortex/working.md` are loaded, reuse that context for later tasks and only
read what actually changed.

## Start of Work

For non-trivial work, subject to Session Reuse above:

1. Confirm this directory is the intended project root.
2. Read `.cortex/project.json` to identify the project and its repository
   and module mapping. Read `.cortex/working.md` for active task state.
3. When prior decisions, failures, or conventions matter, follow
   `.ai/skills/memory-use/SKILL.md` for bounded, source-linked lookup of this
   Project and relevant Workspace records. Never read a sibling Project's
   records. Check source or runtime when freshness matters.
4. Consult `.development_document/index.md` and selected entries when the
   task needs a documented workflow, decision, or plan.
5. Use `.ai/skills/README.md` to load applicable Skills and needed references.
   A task Skill and memory-use may apply together; skip unrelated Skills.
6. Inspect actual source, configuration, dependencies, tests, and error
   output before editing.
7. Execute the smallest scoped change.
8. Run the relevant verification, then write back per Writeback below.

If `.cortex/project.json` still has placeholder IDs, establish the stable
project and repo IDs before writing records. If `.cortex/working.md` has only
placeholder text, record the active goal before non-trivial work.

If a required file is missing, empty, unreadable, or truncated, record that
fact and do not rely on it as evidence.

## D-Cortex Cognitive Functions

When this project uses D-Cortex-style reasoning, treat `Cognitive Functions`
as a structured decision boundary, not as another Agent or a conversational
assistant. The project may implement these functions in its own source, but
the responsibilities remain:

- `Agent`: executes coding, planning, research, or other work.
- `Cognitive Function`: classifies, scores, judges, extracts, verifies, ranks,
  or routes structured input into a bounded result.
- `Hook`: performs deterministic checks such as lint, test, typecheck, build,
  or policy validation.
- `Loop`: controls `execute -> verify -> evaluate -> repair`.
- `Provider`: supplies the model behind a Cognitive Function and remains
  replaceable behind the project's normalized contract.

Run deterministic checks first. For model-backed evaluation, pass only the
needed context and return an enum, boolean, score, rank, or compact JSON
object. Do not make downstream workflow code parse a prose answer to recover
the decision. This project contract does not require a new state directory or
automatic dispatch; use the existing session-local loop and active working
context.

## D-Cortex Context and Memory Boundary

Treat context and memory as separate responsibilities. The project has a
portable record file; initialization does not copy or register an optional
CLI/MCP runtime. Use available bound memory tools, or scoped `rg` searches
and selected file reads per `.ai/skills/memory-use/SKILL.md`. To attach a
runtime, use `.ai/examples/recipes/memory-runtime-setup.md`; no fixed template
path, automatic dispatch, or archive service is required.

- `Working context` contains the active goal, plan, state, attempts, failures,
  reasons, unresolved issues, and next action.
- `Compaction` summarizes a whole phase or session, preserving that active
  state; it is not a per-tool-call keep/drop classifier.
- `Structured memory` contains reusable typed records with project scope,
  lifecycle state, and source references. Agent names are provenance only.
- `Retrieval` filters by project before ranking and returns only relevant,
  bounded records. It does not replace active task state or source evidence.
- `Raw archive` is recoverable original evidence when the project implements
  one; absence from working context is not deletion.

Until an open task is complete, explicitly resolved, or handed off with an
equivalent checkpoint, do not discard its attempts, failures, or reasons. A
future knowledge-consolidation process may promote durable knowledge, but it
must not own context-window rescue or discard active task state.

### Adoption boundary

This directory is a backend-neutral project skeleton with a portable JSONL
record artifact. When initialized as a real project, it also receives
synthetic contract fixtures under `.ai/examples/fixtures/`. Fixtures are test
inputs, never project memory or production data.

An adopting project may implement an adapter only after it names the storage,
retention, access, deletion, and runtime evidence boundaries in its own source
and development documents. Do not add a database, vector service, automatic
hook, or provider to this skeleton merely to make the fixtures pass.

## Project Boundaries

- Executable behavior is defined by source, tests, schemas, configuration,
  and runtime output — not by this file or memory.
- `.cortex/working.md` is active working context, not durable memory.
- `.cortex/project.json` maps repos; `.cortex/records.jsonl` is the
  canonical local record artifact. Project ID is the memory isolation key.
- `.development_document/` is durable project knowledge.
- `.ai/` is vendored tooling, not project truth; nothing in it describes this
  codebase.
- Never place secrets, credentials, tokens, cookies, private keys, or
  personal data in tracked files, memory, or logs.

## Working Rules

- Read relevant files, configuration, dependencies, and errors first.
- Separate verified facts from hypotheses and stale memory.
- Make the smallest change that completes the request.
- For non-trivial implementation, define a small acceptance set and run the
  verification loop after each meaningful change: verify, evaluate, repair on
  failure, and verify again before moving on. Keep attempt state in the
  session; write back only durable outcomes.
- Preserve unrelated user changes.
- Avoid unnecessary dependencies, abstractions, and duplicate files.
- Keep artifact, local, VPS, staging/production, and live-workflow status
  separate. Localhost never proves a remote or production state.
- Warn before destructive, irreversible, security-sensitive, or broad
  changes. Check whether this repo is under version control before assuming
  `git` can undo a mistake.

## Execution Target

Name the target before verifying, at whatever grain the task warrants — this
is a note-to-self, not a form to fill out for trivial work:

- `artifact`: source, documentation, or configuration file only;
- `local`: this workstation or a local container/runtime;
- `VPS`: a named remote host verified by identity and service output;
- `staging` or `production`: the named deployed environment with
  authenticated service evidence;
- `live`: an external workflow execution, import, dry-run, or activation with
  a runtime identifier.

Do not claim `done`, `deployed`, `running`, or `executed` while the
corresponding evidence is unknown or blocked. Use
`.ai/skills/quality-gate/SKILL.md` to pick the gate level for the risk of the
work — most day-to-day work does not need the full critical-workflow gate.

## UI and Visual Work

Only applies if this project has a `.design/` contract. Before changing UI,
read `.design/DESIGN.md` and the relevant files under `.design/foundations/`,
`.design/semantic/`, `.design/patterns/`, `.design/references/`, plus
`.ai/skills/design-contract/SKILL.md`.

1. Inspect existing components and the permitted visual references.
2. Use only approved project tokens and patterns; do not invent colors, type
   scale, spacing, radii, shadows, or motion values.
3. Confirm the `390px`, `768px`, and `1440px` responsive intent and forbidden
   fallback patterns.
4. Implement the smallest scoped change.
5. Render and compare at the named viewports.
6. Record measurable deviations in `.design/visual-qa.md` and fix only those
   deviations. Do not redesign adjacent sections during correction.

If `.design/DESIGN.md` is still `unadopted`, stop at visual extraction and
human review instead of choosing a generic UI language.

## Verification

Follow `.ai/skills/quality-gate/SKILL.md` and the vendored
`.ai/examples/patterns/verification-loop.md`. After each meaningful change,
run the smallest relevant project checks — unit tests, integration tests, type
checks, lint, builds, or runtime smoke checks — and evaluate them against the
acceptance criteria. On failure, retain only a bounded actionable error,
repair, and rerun the failed check plus the affected regression check.

For UI, render and inspect the affected route and named viewports; source-code
inspection alone is not verification. Record the exact final command,
interaction, viewport, or runtime evidence in `.cortex/working.md` so the next
session doesn't have to rediscover it.
Report exact commands and results. If verification is blocked, name the
blocker and do not describe the change as fully verified.

## Writeback

After meaningful work, update only what gained durable value:

- `.cortex/working.md`: active objective, attempts, failures, next action,
  and exact verification evidence;
- `.cortex/records.jsonl`: source-backed reusable facts, decisions, and
  constraints after lifecycle review;
- `.development_document/`: durable context, decisions, workflows, plans, or
  tasks worth keeping beyond the current focus.

Do not copy all durable records into the working-context file. Retrieve only
what the task needs and verify drift-prone claims against source.

## Reporting

Lead with the result. State what changed, how it was verified, and any
remaining blocker. Skip the sections that don't apply instead of filling them
in with "not in scope" every time.

```text
Done status: pass | blocked | partial
Artifact status: pass | blocked | not in scope
Local runtime status: pass | blocked | not tested
VPS/staging/production status: pass | blocked | not tested
Residual risk: <plain-language statement>
Evidence: <paths, commands, URLs, or runtime identifiers>
```

## Cross-task improvement

For meaningful work, close the existing task with its acceptance evidence and
update its linked plan (or mark it standalone). Decide whether any reusable
finding warrants a candidate; no finding requires no extra memory entry.
For recurring failures or a selected trial, follow `.ai/skills/quality-gate/SKILL.md`
section “Cross-task improvement” and `.ai/skills/memory-use/SKILL.md`.
Keep owner-qualified method IDs, exact versions, applicability, baseline,
later actual use and regression results linked in task evidence. Trivial work
keeps its skip path. Source review/adoption remains explicit; active memory
alone is not proof of improved outcomes. Preserve partial closeout and open
failures in working context. No background continuation is installed.
