# Repo Wiki production workflow integration

Result: FAIL

Command: `cd electron-agent; npx vitest run electron/app/repoWikiWorkflow.integration.test.ts`

Boundaries: real WorkspaceService and opened-projects.json; compiled Repo Wiki Electron-as-Node OS child; AgentDataService child mode and a second actual Electron-as-Node OS child using production createAgentDataHost / assembleAgentData / AgentDataRuntime / WikiService; production createAgentDataModelPort / ModelRuntimeHost / Pi SDK and a loopback HTTP provider. CodeGraph alone is an unrelated deterministic stub. No external provider, paid calls, precreated Wiki project list, mocked scheduler, or dormant TaskQueue path.

- PASS: real opened-projects.json registration automatically projects repositories, without sessions or renderer create
- PASS: Repo Wiki OS child -> AgentDataService child RPC -> WikiService -> reverse model RPC -> real ModelRuntimeHost/SDK HTTP uses knowledge-b, while app default is app-default-a
- PASS: actual legacy wiki.ingest occupies global budget=1; Repo Wiki waits, and canceling the queued generation never reaches the provider
- PASS: running generation cancel crosses both OS children and reverse main.model.abort; actual provider connection closes, preserving the previous page
- PASS: A -> B -> A, repeated entry and empty workspace preserve host projection IDs; switching cancels old generation and rejects stale/cross-project access
- PASS: queued old model binding rejects MODEL_CHANGED before provider dispatch; new requests resolve the changed AgentData model

Failure: AssertionError: expected 'gren-repowiki:133bad7c2411d9b44f2461a…' not to be 'gren-repowiki:133bad7c2411d9b44f2461a…' // Object.is equality
See workflow-integration.log for the actual process trace.
