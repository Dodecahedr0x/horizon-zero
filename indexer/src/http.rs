//! HTTP API. Date filters use `date=YYYY-MM-DD` or `from` / `to`, UTC, inclusive.

use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::json;

use crate::store::{self, DayRange};

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
}

#[derive(Deserialize, Default)]
pub struct DateParams {
    pub date: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/behaviors", get(behaviors))
        .route("/battlegrounds", get(battlegrounds))
        .route("/battlegrounds/{pubkey}/queue", get(queue))
        .route("/armies", get(armies))
        .route("/army/{pubkey}", get(army))
        .route("/matches", get(battles))
        .route("/battles", get(battles))
        .route("/matches/{pubkey}", get(battle))
        .route("/battles/{pubkey}", get(battle))
        .route("/users", get(users))
        .route("/stats", get(stats))
        .fallback(not_found)
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true }))
}

async fn behaviors(
    State(state): State<AppState>,
    Query(params): Query<DateParams>,
) -> Result<Json<Vec<store::BehaviorOut>>, ApiError> {
    let range = day_range(&params)?;
    let conn = lock(&state)?;
    Ok(Json(store::behaviors(&conn, &range)?))
}

async fn battlegrounds(
    State(state): State<AppState>,
) -> Result<Json<Vec<store::BattlegroundOut>>, ApiError> {
    let conn = lock(&state)?;
    Ok(Json(store::battlegrounds(&conn)?))
}

async fn queue(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Result<Json<Option<store::BattlegroundOut>>, ApiError> {
    let conn = lock(&state)?;
    Ok(Json(store::battleground(&conn, &pubkey)?))
}

async fn armies(
    State(state): State<AppState>,
    Query(params): Query<OwnerParams>,
) -> Result<Json<Vec<store::ArmyOut>>, ApiError> {
    let conn = lock(&state)?;
    Ok(Json(store::armies(
        &conn,
        params.owner.as_deref().unwrap_or(""),
    )?))
}

async fn army(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Result<Json<Option<store::ArmyOut>>, ApiError> {
    let conn = lock(&state)?;
    Ok(Json(store::army(&conn, &pubkey)?))
}

async fn battles(
    State(state): State<AppState>,
    Query(params): Query<DateParams>,
) -> Result<Json<Vec<store::BattleOut>>, ApiError> {
    let range = day_range(&params)?;
    let conn = lock(&state)?;
    Ok(Json(store::battles(&conn, &range)?))
}

async fn battle(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Result<Json<Option<store::BattleOut>>, ApiError> {
    let conn = lock(&state)?;
    Ok(Json(store::battle(&conn, &pubkey)?))
}

async fn users(
    State(state): State<AppState>,
    Query(params): Query<DateParams>,
) -> Result<Json<Vec<store::UserOut>>, ApiError> {
    let range = day_range(&params)?;
    let conn = lock(&state)?;
    Ok(Json(store::users(&conn, &range)?))
}

/// Public game-wide numbers. Any page may read them, so the landing site can call this across origins.
async fn stats(State(state): State<AppState>) -> Result<Response, ApiError> {
    let conn = lock(&state)?;
    let now = chrono::Utc::now().timestamp();
    let body = store::stats(&conn, now)?;
    Ok((
        [
            (axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=10"),
        ],
        Json(body),
    )
        .into_response())
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
}

#[derive(Deserialize, Default)]
struct OwnerParams {
    owner: Option<String>,
}

fn day_range(params: &DateParams) -> Result<DayRange, ApiError> {
    if let Some(date) = &params.date {
        let day = store::parse_day(date).ok_or(ApiError::BadDate)?;
        return Ok(DayRange {
            from: Some(day.clone()),
            to: Some(day),
        });
    }
    let from = match &params.from {
        Some(value) => Some(store::parse_day(value).ok_or(ApiError::BadDate)?),
        None => None,
    };
    let to = match &params.to {
        Some(value) => Some(store::parse_day(value).ok_or(ApiError::BadDate)?),
        None => None,
    };
    Ok(DayRange { from, to })
}

fn lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, Connection>, ApiError> {
    state.db.lock().map_err(|_| ApiError::Store)
}

enum ApiError {
    BadDate,
    Store,
}

impl From<rusqlite::Error> for ApiError {
    fn from(_: rusqlite::Error) -> Self {
        ApiError::Store
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::BadDate => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "bad date" })),
            )
                .into_response(),
            ApiError::Store => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "store" })),
            )
                .into_response(),
        }
    }
}
