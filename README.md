# ZyroG²i PCM — Deployment MCP Proof of Concept

> **Status: experimental, AI-assisted proof of concept. Not production-ready.**
>
> This repository is published to communicate an architectural idea and invite community review, criticism, adaptation, and forks. The author is not a professional software developer and does not claim to know how to code independently; the implementation was generated with AI assistance. The author has not independently validated every line of code or established that the system is secure or production-ready.

## What is this?

This is an experimental implementation of the **Persistent Context Manager (PCM)** and **Task Maxer** concept within the proposed ZyroG²i / Xlyo architecture.

The idea is to give an AI system a durable, structured place to preserve the operational state it needs across tasks, conversations, process restarts, and worker/model replacement. Instead of treating the conversation transcript as the only memory, PCM stores records such as:

- user interaction profile and selected durable memories;
- project and task records, including confirmed specifications, assumptions, status, dependencies, blockers, open questions, and acceptance criteria;
- decisions and runtime-route records supplied by other components;
- artifact references and provenance;
- operational receipts and audit history;
- knowledge-navigation references and externally supplied capability/hardware observations;
- bounded context views that a replacement worker can use to resume a task;
- versioned persistent state and namespace-scoped snapshot export.

**Task Maxer** is the task-oriented current-state board built on PCM. PCM is the persistence/state layer; it is not intended to be the AI's executive, decision model, hardware scheduler, or tool executor.

## Why publish it?

This repository is a community-facing concept prototype—not a claim that the architecture is novel, proven, or complete. The goal is to make the idea concrete enough for more experienced developers to inspect the code, point out mistakes, adapt the design, or build a better implementation.

Feedback and pull requests are welcome. Please assume the project needs independent technical review.

## Important limitations

- This implementation is AI-assisted and has not been independently audited.
- **Do not use it as the only storage for important or irreplaceable data.** Back up anything you experiment with.
- Build compatibility, MCP interoperability, security, data deletion behavior, migrations, concurrency, and all tests must be independently checked before relying on it.
- The repository's included tests and scripts are not evidence of correctness merely because they exist.
- The initial interface is a local MCP server using `stdio`; it does not automatically connect to Gemini's web/mobile app or to an arbitrary cloud host.
- PCM records capability observations supplied by other components. It does not itself probe hardware, benchmark devices, schedule execution, or independently verify a model's claims.
- This is the deployment/runtime PCM only. Training-time curricula and exploration-state management, the broader AI Execution Harness, and the hardware scheduler are outside the scope of this repository.

## Current implementation outline

- TypeScript application and MCP tool handlers;
- SQLite-backed persistence through a native N-API binding;
- schema migration support;
- profile, memory, project, task, decision, artifact, receipt, runtime-route, capability-observation, and knowledge-navigation tools;
- version checks, idempotency support, and state-change receipts in the service layer;
- unit, integration, and security-oriented tests.

These are descriptions of the files included, not a certification that every feature works as intended.

## Build and run

See [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) before attempting to build. The project currently needs a clean-install/build/test verification pass, and some scripts or dependencies may need correction.

The intended local workflow is:

```bash
npm install
npm run build
npm run typecheck
npm test
npm start
```

Do not interpret these commands as confirmed to pass on every operating system. The native SQLite binding and MCP SDK setup need special attention; see the implementation status report.

Configuration variables are documented in [`.env.example`](.env.example). Never commit actual user databases, exports, secrets, or `.env` files.

## Architecture boundary

```text
AI host / coordinator (outside this repository)
        │
        ▼
MCP interface (stdio)
        │
        ▼
PCM service and Task Maxer state logic
        │
        ▼
SQLite persistence + migrations + receipts
```

The broader ZyroG²i architecture is a research/engineering hypothesis. This repository implements only a small proposed support component, not ZyroG²i, Xlyo, or Zyrix as a complete intelligent system.

## Community contributions

Useful contributions include:

- reproducing and documenting build/test failures;
- replacing fragile build scripts with conventional tooling;
- reviewing MCP SDK usage and compatibility;
- reviewing SQLite transactions, migrations, and native-binding portability;
- testing namespace isolation, artifact-path restrictions, deletion semantics, and redaction;
- suggesting a simpler minimum viable PCM schema;
- improving documentation and examples.

Please distinguish observed failures from assumptions, and include reproducible steps with bug reports.

## License

The source files declare MIT licensing, and the repository includes the MIT License in [`LICENSE`](LICENSE). Review the licensing and provenance of AI-generated code and all dependencies before reuse.
