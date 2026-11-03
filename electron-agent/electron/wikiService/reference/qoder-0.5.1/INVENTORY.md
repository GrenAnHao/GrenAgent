# Fixed reference inventory

Qoder 0.5.1 stable / knowledge.center 0.1.1 / context 1.0.91.b22f2d0a / revision 2026102902. Source: `.tmp-qoder-analysis/engine/qoder-search.pretty.mjs`; line numbers refer to that static local copy.

## Templates and execution

| Purpose | System | User | Source |
| --- | --- | --- | --- |
| full overview | Pw | overview_generate | pkt 91701; LUn 93267 |
| full catalogue-plan | Pw | catalogue_analyze | pkt 90198; UUn 93300 |
| full catalogue root | catalogue_generate + Pw | catalogue_generate_root_user_prompt | pkt 90552, 90715; Ukt 92981 |
| full catalogue child | catalogue_generate + Pw | catalogue_generate_child_user_prompt | pkt 90552, 90692; Ukt 92981 |
| full page / incremental add | generate_wiki_system_prompt + Pw | generate_wiki_user_prompt | pkt 90904, 91668; KUn 93069; xTe 93914 |
| incremental commit-analysis | commit_message_analysis_divergence_system + Pw | commit_message_analysis_divergence_user | pkt 90722, 90841; xTe 93802 |
| incremental catalogue-analysis | catalog_increment_divergence_system + Pw | catalog_increment_divergence_user | pkt 90069, 90104; xTe 93826 |
| incremental page-update | Pw | update_wiki | pkt 91917; xTe 93888 |

The 12 templates plus author partial and Pw are retained in `templates.ts` and `referencePrompts.ts`. Their variables are the original `{{ .Name }}` slots, not translated aliases. Base defaults `fTe/qkt` 92943–92965; child parent serialization/level/depth 92981–93024; page author template/notes and literal Branch main 93069–93090; retry recovery `Akt` 92430–92455. The exact original template text and all its placeholders are in the asset; `render-fixtures.json` contains full independently text-transformed outputs for each purpose and both catalogue branches with author notes and a template.

## Defaults and branches

`_n/nf` 55440–55484 and `uM/eTe` 89949–90049: 150000 context estimate, 16000 output tokens, 10 work steps plus one closing turn (`R5` 119086–119476), 2000 ListDir tokens, two item attempts, overview/catalogue/page minimum 200/300/250 UTF-8 bytes, depth 4, release concurrency 3, debug concurrency 6. Delay overview/plan/catalogue/commit/catalogue-analysis 5000 ms; full page 3000 ms; incremental update/add 2000 ms. Git input bounds: 500 message and 20000 diff tokens, apply/drop 100; runPolicy max 100 changed commits / 1000 files (34163–34164, 55618–55619). These are not user spending limits or accumulated usage caps.

Full `Kkt/LUn/UUn` 93181–93336: explicit author pages bypass automatic stages; otherwise overview/plan precede catalogue, then page. `ZUn/VUn` 93038–93179: expand shallowest tree levels, page pool does not depend on page DAG; no successful first-round page means error, otherwise retry failed subset one compensation round. Each invocation still has two attempts. `bf` 92475–92596 retries eligible execution/validation failures and retains attempt records.

Incremental `l4n/tSt` 94390–94667: baseline and Git gate; no indexed changed file advances without model; explicit update above limit denied, applicable sync may fall back; `xTe` 93768–94085 calls commit → catalogue analysis → update pool → add pool and records explicit deletes. Incremental catalogue inputs include prior tree, diffs, workspace tree, commit analysis and author notes; its run-scoped `SearchWiki/ReadWiki` read only frozen prior catalogue/pages. `wTe` 93427–93620 parses operations, deduplicates, verifies references/parent deletion and assigns IDs. `dTe/K9/fM` 92732–92866 parse full catalogue/page; `Ed/P5e` 3720–3805 bound repair of complete JSON (256 KiB, depth 64), do not complete truncation.

## Provenance classes

- **reference**: static assets, purpose composition, local parser and documented branches above. Exact original tool schemas for SDK-native Read/Glob/Grep and server-provided hidden messages are not present here.
- **host-adapter**: Pi models, user authorization, snapshot lifetime and registration of tools, repository path confinement, request scheduling, accounting and persistence. `wikiTools.ts` supplies pure schemas/handlers only; it does not grant or register them.
- **unknown**: SDK-native complete tool schemas, implicit messages, compaction, cloud queues and model routing, provider output and live latency. No matching claim for those.

## JSON repair provenance and distribution

The Qoder context archive contains `runtime-manifest.json`, but no dependency lock, package metadata, third-party notice or source map naming the bundled repair library. The local repo has no installed `jsonrepair` package. The bundled routine resembles jsonrepair and contains HTML-entity repair; the upstream [changelog](https://github.com/josdejong/jsonrepair/blob/v3.15.0/CHANGELOG.md) identifies that feature in 3.15.0. This supports 3.15.0 as a reference candidate, not proof of Qoder's exact version or absence of changes.

To avoid redistributing unattributed bundled code, `jsonRepair.ts` now calls the three unmodified upstream v3.15.0 source files under `jsonrepair-3.15.0/`, obtained from the official [v3.15.0 tag](https://github.com/josdejong/jsonrepair/tree/v3.15.0/src), with the complete original [ISC license](https://github.com/josdejong/jsonrepair/blob/v3.15.0/LICENSE.md) preserved locally in that directory. The balanced-value scanner is local adaptation; the 256 KiB / depth-64 guard remains in `referenceParsers.ts`. This is a licensed host implementation with strong source correspondence, not a proven byte-identical Qoder dependency.

The application packaging owner must include this license in `build/licenses` via the existing third-party license collector: source files are not otherwise delivered by `electron-builder.yml`. Runtime packaging and license visibility require user-authorized build inspection and are not verified here.
