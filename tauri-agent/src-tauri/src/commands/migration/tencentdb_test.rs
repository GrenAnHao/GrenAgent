use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use super::{
    accepted_message_count, archive_allowed, can_execute_from, close_pi_sidecar,
    code_graph_sample_contains_content, code_graph_target_is_ready, code_graph_target_status,
    core_recall_contains_content, cutover_plan, detail_contains_target_content,
    execution_result_state, find_existing_skill_id, is_not_found_error, json_message,
    knowledge_target_is_ready, local_migration_counts_match, matching_message_prefix,
    page_read_contains_content, page_refs, persist_target_id, pi_probe_messages_contain_nonce,
    pi_recall_probe, pi_sidecar_is_alive, recover_interrupted_run, remote_count_matches,
    replace_run_file, resolve_manual_item, sample_contains_target, scan_legacy_sources,
    select_items, skill_frontmatter, split_message_for_tencentdb, split_text_for_tencentdb,
    stable_wiki_identity, stable_wiki_upload_name, verification_result_state, wiki_target_is_ready,
    wiki_upload_filename, wiki_upload_files, workspace_run_key, GatewayClient,
    ManualResolutionKind, MigrationBatch, MigrationItem, MigrationReport, MigrationRun,
    MigrationSourceKind, MigrationState, VerificationReport,
};

fn fixture_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tdai-migration-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn fixture_with_missing_source() -> PathBuf {
    let root = fixture_dir();
    let db = root.join(".pi/knowledge/default.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE chunks(id TEXT PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB);
         INSERT INTO chunks(id, source, text) VALUES ('c1', 'docs/missing.md', 'legacy');",
    )
    .unwrap();
    root
}

fn fixture_with_wiki_source() -> PathBuf {
    let root = fixture_dir();
    let document = root.join("docs/source.md");
    fs::create_dir_all(document.parent().unwrap()).unwrap();
    fs::write(&document, "# source").unwrap();
    let db = root.join(".pi/knowledge/default.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE chunks(id TEXT PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB);
         INSERT INTO chunks(id, source, text) VALUES ('c1', 'docs/source.md', 'one');
         INSERT INTO chunks(id, source, text) VALUES ('c2', 'docs/source.md', 'two');
         INSERT INTO chunks(id, source, text) VALUES ('c3', 'docs/source.md', 'three');",
    )
    .unwrap();
    root
}

#[test]
fn missing_original_document_requires_manual_migration() {
    let root = fixture_with_missing_source();
    let report = scan_legacy_sources(Path::new(&root)).unwrap();
    assert_eq!(report.items[0].state, MigrationState::Manual);
    fs::remove_dir_all(root).ok();
}

#[test]
fn legacy_extensions_remain_enabled_before_verification() {
    assert!(cutover_plan(false).keep_legacy_extensions());
    assert!(!cutover_plan(true).keep_legacy_extensions());
    assert!(!cutover_plan(true).remove_legacy_commands);
    assert!(!cutover_plan(true).remove_codebase_resource);
    assert!(cutover_plan(true).preserve_legacy_data);
    assert!(cutover_plan(true).preserve_session_memory);
}

#[test]
fn scans_memory_and_skill_counts_without_touching_real_home() {
    let root = fixture_dir();
    let db = root.join(".pi/memory/memory.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT, createdAt INTEGER NOT NULL, embedding BLOB);
         INSERT INTO memories VALUES ('m1', 'keep this', 'fact', 1, NULL);
         INSERT INTO memories VALUES ('m2', 'and this', NULL, 2, NULL);",
    )
    .unwrap();
    let skill = root.join(".agents/skills/review");
    fs::create_dir_all(&skill).unwrap();
    fs::write(skill.join("SKILL.md"), "# review").unwrap();
    let report = scan_legacy_sources(Path::new(&root)).unwrap();
    assert!(report.items.iter().any(|item| item.item_count == 2));
    assert!(report
        .items
        .iter()
        .any(|item| item.source_path.ends_with("review")));
    fs::remove_dir_all(root).ok();
}

#[test]
fn legacy_l1_source_is_explicitly_manual_when_public_api_cannot_create_it() {
    let root = fixture_dir();
    let db = root.join(".pi/memory/memory.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT, createdAt INTEGER NOT NULL);
         INSERT INTO memories VALUES ('m1', 'legacy fact', 'fact', 1);",
    )
    .unwrap();

    let report = scan_legacy_sources(Path::new(&root)).unwrap();
    let memory = report
        .items
        .iter()
        .find(|item| item.source_kind == MigrationSourceKind::MemorySqlite)
        .unwrap();
    assert_eq!(memory.state, MigrationState::Manual);
    assert!(memory
        .error
        .as_deref()
        .is_some_and(|error| error.contains("cannot create")));
    fs::remove_dir_all(root).ok();
}

#[test]
fn manual_l1_resolution_is_explicit_auditable_and_unblocks_counts() {
    let root = fixture_dir();
    let db = root.join(".pi/memory/memory.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT, createdAt INTEGER NOT NULL);
         INSERT INTO memories VALUES ('m1', 'legacy fact', 'fact', 1);",
    )
    .unwrap();
    drop(conn);

    let mut run = MigrationRun {
        report: scan_legacy_sources(&root).unwrap(),
        batches: Vec::new(),
        selected_ids: None,
        verification: None,
        archived_at: None,
    };
    run.report.state = MigrationState::Migrated;
    let run_id = run.report.run_id.clone();
    let source_id = run.report.items[0].source_id.clone();
    assert_eq!(run.report.manual_count, 1);
    assert!(!local_migration_counts_match(&run.report));
    assert!(resolve_manual_item(
        &mut run.clone(),
        &run_id,
        &source_id,
        ManualResolutionKind::ExplicitWaived,
        "  "
    )
    .is_err());

    resolve_manual_item(
        &mut run,
        &run_id,
        &source_id,
        ManualResolutionKind::ExternalCompleted,
        "Replayed the source conversations in the remote workspace",
    )
    .unwrap();

    let item = &run.report.items[0];
    assert_eq!(item.state, MigrationState::Manual);
    assert_eq!(run.report.manual_count, 0);
    assert!(local_migration_counts_match(&run.report));
    let resolution = item.manual_resolution.as_ref().unwrap();
    assert_eq!(resolution.kind, ManualResolutionKind::ExternalCompleted);
    assert!(!resolution.resolved_at.is_empty());
    assert!(resolution.note.contains("Replayed"));
    fs::remove_dir_all(root).ok();
}

#[test]
fn manual_resolution_is_bound_to_the_run_and_cannot_be_overwritten() {
    let mut run = MigrationRun {
        report: MigrationReport {
            run_id: "run".into(),
            workspace: "workspace".into(),
            state: MigrationState::Migrated,
            items: vec![test_item("memory:/legacy.db", MigrationState::Manual)],
            total_count: 1,
            manual_count: 1,
            updated_at: "now".into(),
        },
        batches: Vec::new(),
        selected_ids: None,
        verification: None,
        archived_at: None,
    };

    assert!(resolve_manual_item(
        &mut run,
        "stale-run",
        "memory:/legacy.db",
        ManualResolutionKind::ExplicitWaived,
        "keep for audit",
    )
    .is_err());
    resolve_manual_item(
        &mut run,
        "run",
        "memory:/legacy.db",
        ManualResolutionKind::ExplicitWaived,
        "keep for audit",
    )
    .unwrap();
    resolve_manual_item(
        &mut run,
        "run",
        "memory:/legacy.db",
        ManualResolutionKind::ExplicitWaived,
        "keep for audit",
    )
    .unwrap();
    assert!(resolve_manual_item(
        &mut run,
        "run",
        "memory:/legacy.db",
        ManualResolutionKind::ExternalCompleted,
        "changed later",
    )
    .is_err());
}

#[test]
fn migration_status_only_treats_missing_files_as_absent() {
    let missing = anyhow::Error::new(std::io::Error::new(std::io::ErrorKind::NotFound, "missing"));
    let denied = anyhow::Error::new(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "denied",
    ));
    assert!(is_not_found_error(&missing));
    assert!(!is_not_found_error(&denied));
    assert!(!is_not_found_error(&anyhow::anyhow!(
        "invalid migration JSON"
    )));
}

#[test]
fn wiki_source_counts_as_one_document_and_preserves_legacy_chunk_count() {
    let root = fixture_with_wiki_source();
    let report = scan_legacy_sources(Path::new(&root)).unwrap();
    let wiki = report
        .items
        .iter()
        .find(|item| item.source_kind == MigrationSourceKind::Wiki)
        .unwrap();
    assert_eq!(wiki.item_count, 1);
    assert_eq!(
        wiki.metadata.get("legacyChunkCount").map(String::as_str),
        Some("3")
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn migration_batch_serializes_required_audit_fields() {
    let batch = MigrationBatch {
        source_id: "memory:/legacy.db".into(),
        target_id: Some("legacy-m1".into()),
        count: 3,
        errors: vec!["temporary gateway failure".into()],
        retryable: true,
    };
    let value = serde_json::to_value(batch).unwrap();
    assert_eq!(
        value.get("sourceId").and_then(|v| v.as_str()),
        Some("memory:/legacy.db")
    );
    assert_eq!(
        value.get("targetId").and_then(|v| v.as_str()),
        Some("legacy-m1")
    );
    assert_eq!(value.get("count").and_then(|v| v.as_u64()), Some(3));
    assert_eq!(
        value.get("errors").and_then(|v| v.as_array()).map(Vec::len),
        Some(1)
    );
    assert_eq!(value.get("retryable").and_then(|v| v.as_bool()), Some(true));
}

#[test]
fn legacy_migration_run_deserializes_with_no_batches() {
    let value = serde_json::json!({
        "report": {
            "runId": "run",
            "workspace": "workspace",
            "state": "scanned",
            "items": [],
            "totalCount": 0,
            "manualCount": 0,
            "updatedAt": "now"
        },
        "verification": null,
        "archivedAt": null
    });
    let run: MigrationRun = serde_json::from_value(value).unwrap();
    assert!(run.batches.is_empty());
}

fn test_item(source_id: &str, state: MigrationState) -> MigrationItem {
    MigrationItem {
        source_id: source_id.into(),
        source_kind: MigrationSourceKind::MemorySqlite,
        source_path: source_id.into(),
        state,
        item_count: 1,
        byte_count: 0,
        migrated_count: 0,
        target_id: None,
        error: None,
        retryable: true,
        metadata: Default::default(),
        manual_resolution: None,
    }
}

#[test]
fn retries_only_pending_or_failed_items() {
    let report = MigrationReport {
        run_id: "run".into(),
        workspace: "workspace".into(),
        state: MigrationState::Failed,
        items: vec![
            test_item("scanned", MigrationState::Scanned),
            test_item("preview", MigrationState::Preview),
            test_item("failed", MigrationState::Failed),
            test_item("migrated", MigrationState::Migrated),
            test_item("manual", MigrationState::Manual),
        ],
        total_count: 5,
        manual_count: 1,
        updated_at: "now".into(),
    };
    assert_eq!(select_items(&report, None), vec![0, 1, 2]);
}

#[test]
fn long_text_is_split_at_tencentdb_character_limit_without_loss() {
    let text = format!("{}终", "a".repeat(8192));
    let parts = split_text_for_tencentdb(&text).unwrap();
    assert!(parts.len() > 1);
    assert!(parts.iter().all(|part| part.chars().count() <= 8192));
    assert_eq!(parts.concat(), text);
}

#[test]
fn astral_characters_respect_the_javascript_utf16_limit() {
    let text = "\u{1f642}".repeat(4097);
    let parts = split_text_for_tencentdb(&text).unwrap();
    assert_eq!(parts.len(), 2);
    assert!(parts.iter().all(|part| part.encode_utf16().count() <= 8192));
    assert_eq!(parts.concat(), text);
}

#[test]
fn long_session_message_is_expanded_before_upload() {
    let text = format!("{}终", "a".repeat(8192));
    let raw = serde_json::json!({
        "type": "message",
        "message": { "role": "user", "content": text }
    });
    let message = json_message(&raw).unwrap();
    let parts = split_message_for_tencentdb(message).unwrap();
    assert_eq!(parts.len(), 2);
    assert!(parts.iter().all(|part| {
        part.get("content")
            .and_then(|value| value.as_str())
            .is_some_and(|content| content.chars().count() <= 8192)
    }));
    let reconstructed = parts
        .iter()
        .filter_map(|part| part.get("content").and_then(|value| value.as_str()))
        .collect::<String>();
    assert_eq!(reconstructed, text);
}

#[test]
fn unsupported_l0_roles_are_preserved_as_annotated_assistant_messages() {
    let cases = [
        ("system", "policy", "[system]\npolicy"),
        ("toolCall", "call", "[tool_call]\ncall"),
        ("toolResult", "result", "[tool_result]\nresult"),
    ];
    for (role, input_content, expected_content) in cases {
        let raw = serde_json::json!({
            "type": "message",
            "message": { "role": role, "content": input_content, "timestamp": 1_700_000_000_000_i64 }
        });
        let normalized = json_message(&raw).unwrap();
        assert_eq!(normalized["role"], "assistant");
        assert_eq!(normalized["content"], expected_content);
        assert_eq!(normalized["timestamp"], "2023-11-14T22:13:20.000Z");
    }
}

#[test]
fn invalid_l0_timestamp_is_omitted_instead_of_sent_to_v3() {
    let raw = serde_json::json!({
        "type": "message",
        "message": { "role": "user", "content": "hello", "timestamp": "not-a-date" }
    });
    let normalized = json_message(&raw).unwrap();
    assert!(normalized.get("timestamp").is_none());
}

#[test]
fn partial_conversation_batch_acceptance_is_an_error() {
    let result = serde_json::json!({ "accepted_ids": ["first-part"] });
    let error = accepted_message_count(&result, 2).unwrap_err();
    assert!(error.to_string().contains("accepted 1 of 2"));
}

#[test]
fn missing_conversation_acceptance_is_an_error() {
    let error = accepted_message_count(&serde_json::json!({}), 1).unwrap_err();
    assert!(error.to_string().contains("accepted_ids"));
}

#[test]
fn interrupted_execution_can_resume_and_failures_do_not_advance_to_verification() {
    assert!(can_execute_from(&MigrationState::Executing));
    assert_eq!(
        execution_result_state(&[
            test_item("migrated", MigrationState::Migrated),
            test_item("failed", MigrationState::Failed),
        ]),
        MigrationState::Failed
    );
    assert_eq!(
        execution_result_state(&[test_item("migrated", MigrationState::Migrated)]),
        MigrationState::Verifying
    );
    assert_eq!(
        execution_result_state(&[
            test_item("migrated", MigrationState::Migrated),
            test_item("pending", MigrationState::Scanned),
        ]),
        MigrationState::Preview
    );
}

#[test]
fn manual_items_do_not_turn_a_completed_import_into_a_failed_run() {
    assert_eq!(
        execution_result_state(&[
            test_item("migrated", MigrationState::Migrated),
            test_item("manual", MigrationState::Manual),
        ]),
        MigrationState::Migrated
    );
}

#[test]
fn interrupted_run_is_settled_before_resume() {
    let mut run = MigrationRun {
        report: MigrationReport {
            run_id: "run".into(),
            workspace: "workspace".into(),
            state: MigrationState::Executing,
            items: vec![test_item("failed", MigrationState::Failed)],
            total_count: 1,
            manual_count: 0,
            updated_at: "now".into(),
        },
        batches: vec![MigrationBatch {
            source_id: "failed".into(),
            target_id: None,
            count: 0,
            errors: Vec::new(),
            retryable: true,
        }],
        selected_ids: None,
        verification: None,
        archived_at: None,
    };

    assert!(recover_interrupted_run(&mut run));
    assert_eq!(run.report.state, MigrationState::Failed);
    assert!(run.batches[0].retryable);
    assert!(run.batches[0]
        .errors
        .iter()
        .any(|error| error.contains("stopped")));
}

#[test]
fn interrupted_batch_marks_its_source_failed_and_retryable() {
    let mut run = MigrationRun {
        report: MigrationReport {
            run_id: "run".into(),
            workspace: "workspace".into(),
            state: MigrationState::Executing,
            items: vec![test_item("in-flight", MigrationState::Scanned)],
            total_count: 1,
            manual_count: 0,
            updated_at: "now".into(),
        },
        batches: vec![MigrationBatch {
            source_id: "in-flight".into(),
            target_id: None,
            count: 0,
            errors: Vec::new(),
            retryable: true,
        }],
        selected_ids: None,
        verification: None,
        archived_at: None,
    };

    recover_interrupted_run(&mut run);
    assert_eq!(run.report.items[0].state, MigrationState::Failed);
    assert!(run.report.items[0].retryable);
    assert!(run.report.items[0]
        .error
        .as_deref()
        .is_some_and(|error| error.contains("stopped")));
    assert!(run.batches[0].retryable);
}

#[test]
fn completed_batches_persist_the_recovered_final_state() {
    let mut run = MigrationRun {
        report: MigrationReport {
            run_id: "run".into(),
            workspace: "workspace".into(),
            state: MigrationState::Executing,
            items: vec![test_item("done", MigrationState::Migrated)],
            total_count: 1,
            manual_count: 0,
            updated_at: "now".into(),
        },
        batches: vec![MigrationBatch {
            source_id: "done".into(),
            target_id: Some("target".into()),
            count: 1,
            errors: Vec::new(),
            retryable: false,
        }],
        selected_ids: Some(vec!["done".into()]),
        verification: None,
        archived_at: None,
    };

    assert!(recover_interrupted_run(&mut run));
    assert_eq!(run.report.state, MigrationState::Verifying);
}

#[test]
fn workspace_run_keys_are_stable_and_isolated() {
    let first = workspace_run_key("C:/Projects/alpha");
    let same = workspace_run_key("C:/Projects/alpha");
    let second = workspace_run_key("C:/Projects/beta");
    assert_eq!(first, same);
    assert_ne!(first, second);
    assert!(first.starts_with("migration-"));
}

#[test]
fn run_file_replacement_overwrites_an_existing_state_file() {
    let root = fixture_dir();
    let path = root.join("migration.json");
    let tmp = root.join("migration.json.tmp");
    fs::write(&path, b"old").unwrap();
    fs::write(&tmp, b"new").unwrap();

    replace_run_file(&tmp, &path).unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert!(!tmp.exists());
    fs::remove_dir_all(root).ok();
}

#[test]
fn target_id_is_persisted_before_the_rest_of_a_batch_runs() {
    let mut run = MigrationRun {
        report: MigrationReport {
            run_id: "run".into(),
            workspace: "workspace".into(),
            state: MigrationState::Executing,
            items: vec![test_item("wiki:/source.md", MigrationState::Scanned)],
            total_count: 1,
            manual_count: 0,
            updated_at: "now".into(),
        },
        batches: vec![MigrationBatch {
            source_id: "wiki:/source.md".into(),
            target_id: None,
            count: 0,
            errors: Vec::new(),
            retryable: true,
        }],
        selected_ids: None,
        verification: None,
        archived_at: None,
    };
    persist_target_id(&mut run, 0, 0, "wiki-1");
    assert_eq!(run.report.items[0].target_id.as_deref(), Some("wiki-1"));
    assert_eq!(run.batches[0].target_id.as_deref(), Some("wiki-1"));
}

#[test]
fn remote_total_is_required_for_count_verification() {
    assert!(remote_count_matches(&serde_json::json!({ "total": 2 }), 2));
    assert!(!remote_count_matches(
        &serde_json::json!({ "items": [] }),
        0
    ));
    assert!(!remote_count_matches(&serde_json::json!({ "total": 1 }), 2));
}

#[test]
fn sample_query_requires_a_real_returned_target() {
    assert!(sample_contains_target(&serde_json::json!({
        "items": [{ "id": "m1", "text": "fact" }]
    })));
    assert!(!sample_contains_target(&serde_json::json!({ "items": [] })));
    assert!(!sample_contains_target(&serde_json::json!({ "code": 0 })));
    assert!(sample_contains_target(&serde_json::json!({
        "items": [{ "filename": "source.md", "content": "# source" }]
    })));
    assert!(detail_contains_target_content(
        &serde_json::json!({ "skill_id": "skl-1", "content": "# Skill" }),
        "skill_id"
    ));
    assert!(!detail_contains_target_content(
        &serde_json::json!({ "skill_id": "skl-1", "content": "" }),
        "skill_id"
    ));
    assert!(code_graph_sample_contains_content(&serde_json::json!({
        "text": "src/main.rs",
        "isError": false
    })));
    assert!(!code_graph_sample_contains_content(&serde_json::json!({
        "text": "",
        "isError": false
    })));
}

#[test]
fn conversation_samples_and_core_recall_require_content() {
    assert!(sample_contains_target(&serde_json::json!({
        "messages": [{ "id": "l0-1", "role": "user", "content": "hello" }]
    })));
    assert!(!sample_contains_target(&serde_json::json!({
        "messages": [{ "id": "l0-1", "role": "user", "content": "" }]
    })));
    assert!(core_recall_contains_content(
        &serde_json::json!({ "content": "persona" })
    ));
    assert!(!core_recall_contains_content(
        &serde_json::json!({ "content": null })
    ));
    assert!(!core_recall_contains_content(
        &serde_json::json!({ "code": 0 })
    ));
}

#[test]
fn pi_probe_requires_the_exact_custom_message_nonce() {
    let nonce = "8e3b8dd5-9148-47b7-a45f-e4b6d38d30f8";
    assert!(pi_probe_messages_contain_nonce(
        &serde_json::json!({
            "messages": [{
                "role": "custom",
                "customType": "tencentdb-memory-probe",
                "content": nonce,
                "details": { "nonce": nonce }
            }]
        }),
        nonce
    ));
    assert!(pi_probe_messages_contain_nonce(
        &serde_json::json!({
            "messages": [{
                "type": "message",
                "message": {
                    "role": "custom",
                    "customType": "tencentdb-memory-probe",
                    "content": nonce,
                    "details": { "nonce": nonce }
                }
            }]
        }),
        nonce
    ));
    assert!(!pi_probe_messages_contain_nonce(
        &serde_json::json!({
            "messages": [{
                "role": "custom",
                "customType": "tencentdb-memory-probe",
                "content": nonce,
                "details": { "nonce": "different" }
            }]
        }),
        nonce
    ));
    assert!(!pi_probe_messages_contain_nonce(
        &serde_json::json!({ "messages": [{ "role": "assistant", "content": nonce }] }),
        nonce
    ));
}

#[tokio::test]
async fn pi_verification_requires_a_live_workspace_rpc() {
    use std::sync::Arc;

    use crate::pi::client::PiClient;
    use crate::pi::manager::PiManager;
    use crate::pi::sink::CollectingSink;
    use crate::pi::transport::ChannelTransport;

    let manager = PiManager::new();
    assert!(!pi_sidecar_is_alive(&manager, "/missing").await);

    let (transport, mut outbox) = ChannelTransport::new();
    let client = Arc::new(PiClient::new(
        "/ws".into(),
        Arc::new(transport),
        Arc::new(CollectingSink::default()),
    ));
    manager
        .get_or_open("/ws", || Ok(client.clone()))
        .await
        .unwrap();

    let response_client = client.clone();
    let responder = tokio::spawn(async move {
        let request = outbox.recv().await.unwrap();
        let value: Value = serde_json::from_str(&request).unwrap();
        let id = value.get("id").and_then(Value::as_str).unwrap();
        response_client
            .handle_line(&format!(
                r#"{{"id":"{id}","type":"response","command":"get_state","success":true,"data":{{}}}}"#
            ))
            .await;
    });

    assert!(pi_sidecar_is_alive(&manager, "/ws").await);
    responder.await.unwrap();
}

#[tokio::test]
async fn archive_closes_the_normalized_workspace_key() {
    use std::sync::Arc;

    use crate::pi::client::PiClient;
    use crate::pi::manager::PiManager;
    use crate::pi::sink::CollectingSink;
    use crate::pi::transport::ChannelTransport;

    let root = fixture_dir();
    let stored_key = root.join(".").to_string_lossy().to_string();
    let requested_key = std::fs::canonicalize(&root)
        .unwrap()
        .to_string_lossy()
        .to_string();
    let (transport, _outbox) = ChannelTransport::new();
    let transport = Arc::new(transport);
    let client = Arc::new(PiClient::new(
        stored_key.clone(),
        transport.clone(),
        Arc::new(CollectingSink::default()),
    ));
    let manager = PiManager::new();
    manager
        .get_or_open(&stored_key, || Ok(client))
        .await
        .unwrap();

    close_pi_sidecar(&manager, &requested_key).await;

    assert!(manager.get(&stored_key).await.is_none());
    assert!(transport.is_killed());
    fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn pi_recall_probe_uses_a_real_prompt_and_restores_the_original_session() {
    use std::sync::Arc;

    use crate::pi::client::PiClient;
    use crate::pi::manager::PiManager;
    use crate::pi::sink::CollectingSink;
    use crate::pi::transport::ChannelTransport;

    let root = fixture_dir();
    let workspace = root.to_string_lossy().to_string();
    let original_session = root.join("original.jsonl").to_string_lossy().to_string();
    let temporary_session = root.join("temporary.jsonl").to_string_lossy().to_string();
    let (transport, mut outbox) = ChannelTransport::new();
    let client = Arc::new(PiClient::new(
        workspace.clone(),
        Arc::new(transport),
        Arc::new(CollectingSink::default()),
    ));
    let manager = PiManager::new();
    manager
        .get_or_open(&workspace, || Ok(client.clone()))
        .await
        .unwrap();

    let responder_client = client.clone();
    let responder = tokio::spawn(async move {
        let mut state_calls = 0;
        let mut nonce = String::new();
        while let Some(line) = outbox.recv().await {
            let request: Value = serde_json::from_str(&line).unwrap();
            let id = request.get("id").and_then(Value::as_str).unwrap();
            let command = request.get("type").and_then(Value::as_str).unwrap();
            let response = match command {
                "get_state" => {
                    state_calls += 1;
                    let session_file = if state_calls == 1 {
                        &original_session
                    } else {
                        &temporary_session
                    };
                    serde_json::json!({
                        "id": id,
                        "type": "response",
                        "command": "get_state",
                        "success": true,
                        "data": { "sessionFile": session_file, "isStreaming": false }
                    })
                }
                "new_session" => serde_json::json!({
                    "id": id,
                    "type": "response",
                    "command": "new_session",
                    "success": true,
                    "data": { "cancelled": false }
                }),
                "prompt" => serde_json::json!({
                    "id": id,
                    "type": "response",
                    "command": "prompt",
                    "success": true
                }),
                "get_messages" => {
                    serde_json::json!({
                        "id": id,
                        "type": "response",
                        "command": "get_messages",
                        "success": true,
                        "data": { "messages": [{
                            "role": "custom",
                            "customType": "tencentdb-memory-probe",
                            "content": nonce.clone(),
                            "details": { "nonce": nonce.clone() }
                        }] }
                    })
                }
                "abort" => serde_json::json!({
                    "id": id,
                    "type": "response",
                    "command": "abort",
                    "success": true
                }),
                "switch_session" => {
                    let result = serde_json::json!({
                        "id": id,
                        "type": "response",
                        "command": "switch_session",
                        "success": true,
                        "data": { "cancelled": false }
                    });
                    responder_client.handle_line(&result.to_string()).await;
                    break;
                }
                other => panic!("unexpected Pi command: {other}"),
            };
            if command == "prompt" {
                let message = request.get("message").and_then(Value::as_str).unwrap();
                nonce = message
                    .strip_prefix("[tencentdb-memory-probe:")
                    .and_then(|value| value.strip_suffix(']'))
                    .unwrap()
                    .to_string();
            }
            responder_client.handle_line(&response.to_string()).await;
        }
    });

    let result = pi_recall_probe(&manager, &workspace).await;
    responder.abort();
    assert!(result.unwrap());
    fs::remove_dir_all(root).ok();
}

#[test]
fn asynchronous_knowledge_targets_must_be_ready_before_cutover() {
    assert!(knowledge_target_is_ready(&serde_json::json!({ "status": "ready" })).unwrap());
    assert!(!knowledge_target_is_ready(&serde_json::json!({ "status": "processing" })).unwrap());
    assert!(knowledge_target_is_ready(&serde_json::json!({})).is_err());
    assert!(wiki_target_is_ready(&serde_json::json!({
        "status": "ready",
        "page_count": 1
    }))
    .unwrap());
    assert!(!wiki_target_is_ready(&serde_json::json!({
        "status": "ready",
        "page_count": 0
    }))
    .unwrap());
    assert!(code_graph_target_is_ready(&serde_json::json!({
        "status": "ready",
        "stats": { "files": 2 }
    }))
    .unwrap());
    assert!(!code_graph_target_is_ready(&serde_json::json!({
        "status": "ready",
        "stats": { "files": 0 }
    }))
    .unwrap());
    let pages = serde_json::json!({
        "items": [{ "id": "intro", "path": "wiki/intro.md" }]
    });
    assert_eq!(page_refs(&pages), vec!["intro"]);
    assert!(page_read_contains_content(&serde_json::json!({
        "items": [{ "ref": "intro", "content": "processed" }]
    })));
    assert!(!page_read_contains_content(&serde_json::json!({
        "items": [{ "ref": "intro", "content": "" }]
    })));
    assert_eq!(verification_result_state(false), MigrationState::Verifying);
    assert_eq!(verification_result_state(true), MigrationState::Verified);
}

#[test]
fn skill_retry_only_reuses_the_same_migration_source() {
    let existing = serde_json::json!({
        "items": [{
            "skill_id": "skl-existing",
            "name": "review",
            "metadata": { "migration_source_id": "skill:/local/review" }
        }]
    });
    assert_eq!(
        find_existing_skill_id(&existing, "review", "skill:/local/review").unwrap(),
        Some("skl-existing".into())
    );

    let conflict = find_existing_skill_id(&existing, "review", "skill:/other/review").unwrap_err();
    assert!(conflict.to_string().contains("same name"));
}

#[test]
fn session_retry_only_appends_after_the_matching_remote_prefix() {
    let planned = vec![
        serde_json::json!({ "role": "user", "content": "one" }),
        serde_json::json!({ "role": "assistant", "content": "two" }),
    ];
    assert_eq!(matching_message_prefix(&planned[..1], &planned).unwrap(), 1);
    let conflict = vec![serde_json::json!({ "role": "user", "content": "different" })];
    assert!(matching_message_prefix(&conflict, &planned).is_err());
}

#[test]
fn wiki_upload_uses_a_safe_basename_and_splits_large_utf8_documents() {
    assert_eq!(
        wiki_upload_filename(Path::new("C:/private/docs/source.md")).unwrap(),
        "source.md"
    );
    assert_eq!(
        stable_wiki_upload_name("source.md", "source.md--abc123").unwrap(),
        "source--abc123.md"
    );
    assert_eq!(
        stable_wiki_upload_name("SOURCE.MD", "SOURCE.MD--abc123").unwrap(),
        "SOURCE--abc123.md"
    );
    assert_eq!(
        stable_wiki_upload_name("notes.rst", "notes.rst--abc123").unwrap(),
        "notes--abc123.md"
    );
    let content = "知".repeat(400_000);
    let files = wiki_upload_files("source--abc123.md", &content).unwrap();
    assert!(files.len() > 1);
    assert!(files.iter().all(|file| {
        file.get("content")
            .and_then(|value| value.as_str())
            .is_some_and(|part| part.len() <= 512 * 1024)
            && file
                .get("filename")
                .and_then(Value::as_str)
                .is_some_and(|name| name.ends_with(".md"))
    }));
    let reconstructed = files
        .iter()
        .filter_map(|file| file.get("content").and_then(Value::as_str))
        .collect::<String>();
    assert_eq!(reconstructed, content);
}

#[test]
fn wiki_identity_disambiguates_same_basename_sources() {
    let first = stable_wiki_identity("wiki:/workspace/docs/a/source.md");
    let second = stable_wiki_identity("wiki:/workspace/other/source.md");
    assert_ne!(first, second);
    assert!(first.contains("source.md"));
    assert!(second.contains("source.md"));
}

#[test]
fn skill_name_and_description_come_from_frontmatter() {
    let raw = "---\nname: review-security\ndescription: Check security\n---\n\n# body\n";
    assert_eq!(
        skill_frontmatter(raw).unwrap(),
        ("review-security".to_string(), "Check security".to_string())
    );
}

#[test]
fn skill_frontmatter_without_required_name_or_description_is_rejected() {
    let missing_name = "---\ndescription: Check\n---\nbody";
    let missing_description = "---\nname: review\n---\nbody";
    assert!(skill_frontmatter(missing_name).is_err());
    assert!(skill_frontmatter(missing_description).is_err());
}

#[test]
fn code_graph_pending_target_is_not_synced_again() {
    assert_eq!(
        code_graph_target_status(&serde_json::json!({ "status": "pending" })).unwrap(),
        super::CodeGraphTargetStatus::SkipSync
    );
    assert_eq!(
        code_graph_target_status(&serde_json::json!({ "status": "failed" })).unwrap(),
        super::CodeGraphTargetStatus::RetrySync
    );
    assert!(code_graph_target_status(&serde_json::json!({})).is_err());
}

#[tokio::test]
async fn core_requests_include_the_service_id_header() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let size = socket.read(&mut buffer).await.unwrap();
            if size == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..size]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") && request.ends_with(b"}") {
                break;
            }
        }
        let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 29\r\nconnection: close\r\n\r\n{\"code\":0,\"data\":{\"ok\":true}}",
            )
            .await
            .unwrap();
        request
    });
    let client = GatewayClient {
        core_endpoint: format!("http://{address}"),
        knowledge_endpoint: None,
        api_key: "secret".into(),
        service_id: "personal-memory".into(),
        team_id: "personal:local".into(),
        agent_id: "pi-personal".into(),
        user_id: "local".into(),
        task_id: None,
    };

    client
        .post_core("v3/atomic/query", serde_json::Map::new())
        .await
        .unwrap();
    let request = server.await.unwrap();
    assert!(request.contains("x-tdai-service-id: personal-memory"));
}

#[test]
fn memory_and_knowledge_requests_share_the_project_identity() {
    let client = GatewayClient {
        core_endpoint: "http://127.0.0.1".into(),
        knowledge_endpoint: Some("http://127.0.0.1".into()),
        api_key: "secret".into(),
        service_id: "personal-memory".into(),
        team_id: "personal:local".into(),
        agent_id: "pi-personal".into(),
        user_id: "local".into(),
        task_id: Some("project-1".into()),
    };
    let mut body = serde_json::Map::new();
    client.insert_identity(&mut body);
    assert_eq!(
        body.get("team_id").and_then(Value::as_str),
        Some("personal:local")
    );
    assert_eq!(
        body.get("task_id").and_then(Value::as_str),
        Some("project-1")
    );
}

#[test]
fn archived_cutover_can_be_retried_after_a_marker_write_failure() {
    let run = MigrationRun {
        report: MigrationReport {
            run_id: "run".into(),
            workspace: "workspace".into(),
            state: MigrationState::Archived,
            items: Vec::new(),
            total_count: 0,
            manual_count: 0,
            updated_at: "now".into(),
        },
        batches: Vec::new(),
        selected_ids: None,
        verification: Some(VerificationReport {
            gateway_healthy: true,
            knowledge_healthy: true,
            knowledge_ready: true,
            counts_match: true,
            sample_query: true,
            pi_recall: true,
            passed: true,
            errors: Vec::new(),
            checked_at: "now".into(),
        }),
        archived_at: Some("now".into()),
    };
    assert!(archive_allowed(&run));
}
