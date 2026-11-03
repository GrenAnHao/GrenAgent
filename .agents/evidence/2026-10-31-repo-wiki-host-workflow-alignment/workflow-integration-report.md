# Repo Wiki production workflow integration

Result: PASS

Command: `cd electron-agent; npx vitest run electron/app/repoWikiWorkflow.integration.test.ts`

Boundaries: real WorkspaceService and opened-projects.json; compiled Repo Wiki Electron-as-Node OS child; AgentDataService child mode and a second actual Electron-as-Node OS child using production createAgentDataHost / assembleAgentData / AgentDataRuntime / WikiService; production createAgentDataModelPort / ModelRuntimeHost / Pi SDK and a loopback HTTP provider. CodeGraph alone is an unrelated deterministic stub. No external provider, paid calls, precreated Wiki project list, mocked scheduler, or dormant TaskQueue path.

- PASS: real opened-projects.json registration automatically projects repositories, without sessions or renderer create
- PASS: Repo Wiki OS child -> AgentDataService child RPC -> WikiService -> reverse model RPC -> real ModelRuntimeHost/SDK HTTP uses knowledge-b, while app default is app-default-a
- PASS: actual legacy wiki.ingest occupies global budget=1; Repo Wiki waits, and canceling the queued generation never reaches the provider
- PASS: running generation cancel crosses both OS children and reverse main.model.abort; actual provider connection closes, preserving the previous page
- PASS: A -> B -> A, repeated entry and empty workspace preserve host projection IDs; switching cancels old generation and rejects stale/cross-project access
- PASS: queued old model binding rejects MODEL_CHANGED before provider dispatch; new requests resolve the changed AgentData model
- PASS: same model ID with changed real SDK headers changes cache identity; queued old configuration rejects MODEL_CHANGED, while the new binding sends the changed header

Every RPC/run wait has a deadline. Only this requested workflow was run; no unrelated UI scenarios.

Final Vitest result: 1 test file passed, 1 workflow passed. Test duration 77.49 seconds; total command duration 79.47 seconds. Actual process IDs: parent 4724, AgentData host 91152 (Node 22.22.0), Repo Wiki host 62152.

The same-model/header regression was first reproduced against the real SDK and preserved in `workflow-configuration-guard-red.log` / `.md`. `sdk-model-header-probe.mts` independently confirmed that the bare SDK model stayed identical while `getCompatibilityRequestConfig()` changed.

`npm run verify-notes` passed (132 active notes, 1 archived note; existing evidence warnings). Full `tsc -p tsconfig.node.json --noEmit --pretty false` remains nonzero with 150 diagnostics outside the new workflow test/helper and the related Repo Wiki/model-port files; see `workflow-typecheck.log`. The standalone host-fixture type check also has no fixture-local diagnostics; its imported production dependency diagnostics are in `workflow-host-fixture-typecheck.log`.
