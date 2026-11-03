# Repo Wiki production workflow integration

Result: PASS

Command: `cd electron-agent; npx vitest run electron/app/repoWikiWorkflow.integration.test.ts`

Boundaries: real WorkspaceService and opened-projects.json; compiled Repo Wiki Electron-as-Node OS child; AgentDataService child mode and a second actual Electron-as-Node OS child using production createAgentDataHost / assembleAgentData / AgentDataRuntime / WikiService; production createAgentDataModelPort / ModelRuntimeHost / Pi SDK and a loopback HTTP provider. CodeGraph alone is an unrelated deterministic stub. No external provider, paid calls, precreated Wiki project list, mocked scheduler, or dormant TaskQueue path.

- PASS: real opened-projects.json metadata binds both host repositories without starting Wiki; hydration creates only the current project, without sessions or renderer create
- PASS: Repo Wiki OS child -> AgentDataService child RPC -> WikiService -> reverse model RPC -> real ModelRuntimeHost/SDK HTTP uses knowledge-b, while app default is app-default-a
- PASS: actual legacy wiki.ingest occupies global budget=1; Repo Wiki waits, and canceling the queued generation never reaches the provider
- PASS: running generation cancel crosses both OS children and reverse main.model.abort; actual provider connection closes, preserving the previous page
- PASS: A -> B -> A, repeated entry and empty workspace preserve one RepoWiki OS child and project IDs; switching cancels old generation and rejects stale/cross-project access
- PASS: closing the Wiki panel cancels its actual SDK connection and retires the context without restarting the child or delivering late old-context progress; reopening retains the previous Markdown
- PASS: queued old model binding rejects MODEL_CHANGED before provider dispatch; new requests resolve the changed AgentData model
- PASS: same model ID with changed real SDK headers changes cache identity; queued old configuration rejects MODEL_CHANGED, while the new binding sends the changed header

Every RPC/run wait has a deadline. Only this requested workflow was run; no unrelated UI scenarios.
