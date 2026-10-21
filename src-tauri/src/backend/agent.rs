// Ajan Ağı HTTP uçları — ince sarmalayıcı. Asıl mantık `crate::agent`'te.
//
// Frontend run başlatır, sonra periyodik olarak durumu yoklar (`/api/agent/state`).
// Durum sunucuda (sunucu-otoriteli) tutulur; arayüz yalnızca görüntüler.

use super::BackendState;
use crate::agent::{self, RunRequest};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct StateQuery {
    pub run_id: String,
}

#[derive(Deserialize)]
pub struct CancelBody {
    pub run_id: String,
}

pub async fn agent_run(
    State(state): State<BackendState>,
    Json(req): Json<RunRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let root = state
        .workspace_root
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let run_id = agent::start_run(req, state.bpe.clone(), root, state.agent_runs.clone())
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(json!({ "run_id": run_id })))
}

pub async fn agent_state(
    State(state): State<BackendState>,
    Query(q): Query<StateQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let handle = state
        .agent_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&q.run_id)
        .cloned();
    match handle {
        Some(h) => {
            let snapshot = h.lock().unwrap_or_else(|e| e.into_inner()).state.clone();
            serde_json::to_value(snapshot)
                .map(Json)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
        }
        None => Err((StatusCode::NOT_FOUND, "run not found".to_string())),
    }
}

pub async fn agent_cancel(
    State(state): State<BackendState>,
    Json(body): Json<CancelBody>,
) -> Json<Value> {
    let ok = agent::cancel_run(&body.run_id, &state.agent_runs);
    Json(json!({ "cancelled": ok }))
}
