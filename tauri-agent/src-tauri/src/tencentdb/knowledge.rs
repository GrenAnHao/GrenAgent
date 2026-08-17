use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::Url;
use serde_json::{json, Value};

const ASSET_LIST_PAGE_SIZE: u64 = 100;

fn asset_list_request(team_id: &str, offset: u64) -> Value {
    json!({
        "team_id": team_id,
        "limit": ASSET_LIST_PAGE_SIZE,
        "offset": offset,
    })
}

fn append_asset_page(items: &mut Vec<Value>, data: Value) -> Result<Option<u64>> {
    let object = data
        .as_object()
        .context("TencentDB Knowledge asset page must be an object")?;
    let total = object
        .get("total")
        .and_then(Value::as_u64)
        .context("TencentDB Knowledge asset page total must be a non-negative integer")?;
    let page = object
        .get("items")
        .and_then(Value::as_array)
        .context("TencentDB Knowledge asset page items must be an array")?;
    if page.is_empty() {
        if items.len() as u64 >= total {
            return Ok(None);
        }
        bail!(
            "TencentDB Knowledge asset list ended early at {} of {total}",
            items.len()
        );
    }
    items.extend(page.iter().cloned());
    if items.len() as u64 >= total {
        Ok(None)
    } else {
        Ok(Some(items.len() as u64))
    }
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
pub struct WorkspaceKnowledgeAssets {
    pub code_graph_id: Option<String>,
    pub wiki_id: Option<String>,
    pub repo_url: Option<String>,
    pub branch: Option<String>,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

/// Minimal HTTP client for the bundled/remote MemoryKnowledge control plane.
///
/// Knowledge routes are scoped by service and user identity; credentials stay
/// here so neither the webview nor the Pi extension constructs management
/// requests itself.
#[derive(Clone)]
pub struct KnowledgeClient {
    client: reqwest::Client,
    endpoint: String,
    api_key: String,
    service_id: String,
    user_key: String,
}

#[derive(Debug, serde::Deserialize)]
struct Envelope<T> {
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<T>,
}

impl KnowledgeClient {
    pub fn new(endpoint: &str, api_key: &str, service_id: &str, user_key: &str) -> Result<Self> {
        let mut endpoint = endpoint.trim().trim_end_matches('/').to_string();
        if endpoint.ends_with("/v3") {
            endpoint.truncate(endpoint.len() - 3);
            endpoint = endpoint.trim_end_matches('/').to_string();
        }
        let url = Url::parse(&endpoint).context("TencentDB knowledge endpoint must be a URL")?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("TencentDB knowledge endpoint must use HTTP or HTTPS");
        }
        if endpoint.is_empty()
            || api_key.trim().is_empty()
            || service_id.trim().is_empty()
            || user_key.trim().is_empty()
        {
            bail!("TencentDB knowledge client requires endpoint, API key, service ID and User Key");
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(knowledge_redirect_policy())
                .build()?,
            endpoint,
            api_key: api_key.trim().to_string(),
            service_id: service_id.trim().to_string(),
            user_key: user_key.trim().to_string(),
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Build the final v3 URL. The caller passes a route without `/v3`.
    pub fn route_url(&self, route: &str) -> String {
        format!(
            "{}/v3/{}",
            self.endpoint,
            route.trim_start_matches('/').trim_start_matches("v3/")
        )
    }

    pub async fn post(&self, route: &str, body: Value) -> Result<Value> {
        let response = self
            .client
            .post(self.route_url(route))
            .header("x-tdai-service-id", &self.service_id)
            .header("x-tdai-user-key", &self.user_key)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("TencentDB Knowledge request failed: POST {route}"))?;
        let status = response.status();
        let envelope: Envelope<Value> = response
            .json()
            .await
            .with_context(|| format!("TencentDB Knowledge returned invalid JSON: {route}"))?;
        if envelope.code != 0 {
            let message = if envelope.message.is_empty() {
                format!("HTTP {status}")
            } else {
                envelope.message
            };
            bail!("TencentDB Knowledge rejected {route}: {message}");
        }
        envelope
            .data
            .ok_or_else(|| anyhow::anyhow!("TencentDB Knowledge returned no data: {route}"))
    }

    pub async fn get_health(&self) -> Result<()> {
        let response = self
            .client
            .get(format!("{}/health", self.endpoint))
            .send()
            .await
            .context("TencentDB Knowledge health request failed")?;
        if !response.status().is_success() {
            bail!("TencentDB Knowledge health returned {}", response.status());
        }
        Ok(())
    }

    pub async fn create_code_graph(&self, body: Value) -> Result<Value> {
        self.post("/code-graph/create", body).await
    }

    pub async fn sync_code_graph(&self, code_graph_id: &str, user_id: &str) -> Result<Value> {
        self.post(
            "/code-graph/sync",
            json!({ "code_graph_id": code_graph_id, "user_id": user_id }),
        )
        .await
    }

    pub async fn list_code_graphs(&self, team_id: &str) -> Result<Value> {
        self.list_all_assets("/code-graph/list", team_id).await
    }

    pub async fn get_code_graph(&self, code_graph_id: &str) -> Result<Value> {
        self.post("/code-graph/get", json!({ "code_graph_id": code_graph_id }))
            .await
    }

    pub async fn search_code_graph(
        &self,
        code_graph_id: &str,
        query: &str,
        limit: u64,
    ) -> Result<Value> {
        self.post(
            "/code-graph/search",
            json!({
                "code_graph_id": code_graph_id,
                "query": query,
                "limit": limit,
            }),
        )
        .await
    }

    pub async fn explore_code_graph(
        &self,
        code_graph_id: &str,
        query: &str,
        max_files: u64,
    ) -> Result<Value> {
        self.post(
            "/code-graph/explore",
            json!({
                "code_graph_id": code_graph_id,
                "query": query,
                "maxFiles": max_files,
            }),
        )
        .await
    }

    pub async fn code_graph_callers(
        &self,
        code_graph_id: &str,
        symbol: &str,
        limit: u64,
    ) -> Result<Value> {
        self.post(
            "/code-graph/callers",
            json!({ "code_graph_id": code_graph_id, "symbol": symbol, "limit": limit }),
        )
        .await
    }

    pub async fn code_graph_callees(
        &self,
        code_graph_id: &str,
        symbol: &str,
        limit: u64,
    ) -> Result<Value> {
        self.post(
            "/code-graph/callees",
            json!({ "code_graph_id": code_graph_id, "symbol": symbol, "limit": limit }),
        )
        .await
    }

    pub async fn analyze_code_graph_impact(
        &self,
        code_graph_id: &str,
        symbol: &str,
        depth: u64,
    ) -> Result<Value> {
        self.post(
            "/code-graph/impact",
            json!({ "code_graph_id": code_graph_id, "symbol": symbol, "depth": depth }),
        )
        .await
    }

    pub async fn get_code_graph_node(
        &self,
        code_graph_id: &str,
        symbol: &str,
        include_code: bool,
        file: Option<&str>,
        line: Option<u64>,
    ) -> Result<Value> {
        let mut body = json!({
            "code_graph_id": code_graph_id,
            "symbol": symbol,
            "includeCode": include_code,
        });
        if let Some(file) = file {
            body["file"] = json!(file);
        }
        if let Some(line) = line {
            body["line"] = json!(line);
        }
        self.post("/code-graph/node", body).await
    }

    pub async fn get_code_graph_status(&self, code_graph_id: &str) -> Result<Value> {
        self.post(
            "/code-graph/status",
            json!({ "code_graph_id": code_graph_id }),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn list_code_graph_files(
        &self,
        code_graph_id: &str,
        path: Option<&str>,
        pattern: Option<&str>,
        format: &str,
        include_metadata: bool,
        max_depth: Option<u64>,
    ) -> Result<Value> {
        let mut body = json!({
            "code_graph_id": code_graph_id,
            "format": format,
            "includeMetadata": include_metadata,
        });
        if let Some(path) = path {
            body["path"] = json!(path);
        }
        if let Some(pattern) = pattern {
            body["pattern"] = json!(pattern);
        }
        if let Some(max_depth) = max_depth {
            body["maxDepth"] = json!(max_depth);
        }
        self.post("/code-graph/files", body).await
    }

    pub async fn delete_code_graphs(&self, code_graph_ids: &[String]) -> Result<Value> {
        self.post(
            "/code-graph/delete",
            json!({ "code_graph_ids": code_graph_ids }),
        )
        .await
    }

    pub async fn create_wiki(&self, body: Value) -> Result<Value> {
        self.post("/wiki/create", body).await
    }

    pub async fn list_wikis(&self, team_id: &str) -> Result<Value> {
        self.list_all_assets("/wiki/list", team_id).await
    }

    pub async fn get_wiki(&self, wiki_id: &str) -> Result<Value> {
        self.post("/wiki/get", json!({ "wiki_id": wiki_id })).await
    }

    pub async fn search_wiki(&self, wiki_id: &str, query: &str, limit: u64) -> Result<Value> {
        self.post(
            "/wiki/search",
            json!({ "wiki_id": wiki_id, "query": query, "limit": limit }),
        )
        .await
    }

    pub async fn list_wiki_pages(&self, wiki_id: &str) -> Result<Value> {
        self.post("/wiki/page/ls", json!({ "wiki_id": wiki_id }))
            .await
    }

    pub async fn read_wiki_pages(&self, wiki_id: &str, refs: &[String]) -> Result<Value> {
        self.post(
            "/wiki/page/read",
            json!({ "wiki_id": wiki_id, "refs": refs }),
        )
        .await
    }

    pub async fn delete_wikis(&self, wiki_ids: &[String]) -> Result<Value> {
        self.post("/wiki/delete", json!({ "wiki_ids": wiki_ids }))
            .await
    }

    pub async fn sync_wiki(&self, wiki_id: &str, user_id: &str) -> Result<Value> {
        self.post(
            "/wiki/ingest",
            json!({ "wiki_id": wiki_id, "user_id": user_id }),
        )
        .await
    }

    pub async fn write_wiki_files(
        &self,
        team_id: &str,
        wiki_id: &str,
        files: &[Value],
        user_id: &str,
    ) -> Result<Value> {
        self.post(
            "/wiki/raw/write",
            json!({
                "team_id": team_id,
                "wiki_id": wiki_id,
                "files": files,
                "user_id": user_id,
            }),
        )
        .await
    }

    async fn list_all_assets(&self, route: &str, team_id: &str) -> Result<Value> {
        let mut items = Vec::new();
        let mut offset = 0;
        loop {
            let data = self
                .post(route, asset_list_request(team_id, offset))
                .await?;
            match append_asset_page(&mut items, data)? {
                Some(next_offset) => offset = next_offset,
                None => break,
            }
        }
        let total = items.len();
        Ok(json!({ "items": items, "total": total }))
    }
}

fn knowledge_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::none()
}

#[cfg(test)]
mod tests {
    use super::{
        append_asset_page, asset_list_request, knowledge_redirect_policy, KnowledgeClient,
        ASSET_LIST_PAGE_SIZE,
    };
    use serde_json::json;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{Shutdown, TcpListener};

    #[test]
    fn route_url_normalizes_v3_prefix_without_duplicate_segments() {
        let client =
            KnowledgeClient::new("http://127.0.0.1:8421/v3", "key", "service", "user-key").unwrap();
        assert_eq!(
            client.route_url("/wiki/list"),
            "http://127.0.0.1:8421/v3/wiki/list"
        );
        assert_eq!(
            client.route_url("v3/code-graph/get"),
            "http://127.0.0.1:8421/v3/code-graph/get"
        );
    }

    #[test]
    fn rejects_non_http_endpoint_and_missing_credentials() {
        assert!(KnowledgeClient::new("file:///tmp/k", "key", "service", "user-key").is_err());
        assert!(KnowledgeClient::new("http://127.0.0.1:1", "", "service", "user-key").is_err());
        assert!(KnowledgeClient::new("http://127.0.0.1:1", "key", "", "user-key").is_err());
        assert!(KnowledgeClient::new("http://127.0.0.1:1", "key", "service", "").is_err());
    }

    #[test]
    fn management_payloads_keep_tenant_fields_in_body() {
        let payload = json!({
            "team_id": "personal-local",
            "repo_url": "C:/work/project",
            "branch": "main",
            "user_id": "local",
            "agent_id": "pi-personal",
        });
        assert_eq!(payload["team_id"], "personal-local");
        assert!(payload["repo_url"].as_str().unwrap().contains("project"));
    }

    #[test]
    fn knowledge_http_client_disables_redirects() {
        assert_eq!(format!("{:?}", knowledge_redirect_policy()), "Policy(None)");
    }

    #[tokio::test]
    async fn post_preserves_tool_error_data_from_http_error_envelope() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut content_length = 0;
            let mut user_key = None;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    panic!("test server reached EOF before request headers completed");
                }
                if line == "\r\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    content_length = value.trim().parse().unwrap();
                }
                if let Some(value) = lower.strip_prefix("x-tdai-user-key:") {
                    user_key = Some(value.trim().to_string());
                }
            }
            let mut request_body = vec![0; content_length];
            reader.read_exact(&mut request_body).unwrap();
            drop(reader);
            assert_eq!(user_key.as_deref(), Some("user-key"));

            let body = r#"{"code":0,"message":"ok","data":{"text":"real error","isError":true}}"#;
            write!(
                stream,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            stream.flush().unwrap();
            stream.shutdown(Shutdown::Write).unwrap();
        });

        let client = KnowledgeClient::new(&endpoint, "key", "service", "user-key").unwrap();
        let data = client.post("/code-graph/explore", json!({})).await.unwrap();

        assert_eq!(data, json!({ "text": "real error", "isError": true }));
        server.join().unwrap();
    }

    #[test]
    fn asset_lists_request_explicit_pages_and_continue_until_total() {
        assert_eq!(
            asset_list_request("team-1", 200),
            json!({
                "team_id": "team-1",
                "limit": ASSET_LIST_PAGE_SIZE,
                "offset": 200,
            })
        );

        let mut items = Vec::new();
        assert_eq!(
            append_asset_page(
                &mut items,
                json!({ "items": [{ "id": 1 }, { "id": 2 }], "total": 3 }),
            )
            .unwrap(),
            Some(2)
        );
        assert_eq!(
            append_asset_page(&mut items, json!({ "items": [{ "id": 3 }], "total": 3 }),).unwrap(),
            None
        );
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn asset_list_pagination_rejects_truncated_or_malformed_pages() {
        let mut items = vec![json!({ "id": 1 })];
        assert!(append_asset_page(&mut items, json!({ "items": [], "total": 2 })).is_err());
        assert!(append_asset_page(&mut items, json!({ "items": [], "total": "2" })).is_err());
        assert!(append_asset_page(&mut items, json!({ "total": 1 })).is_err());
    }
}
