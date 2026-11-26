//! One transaction for a batch of SQL statements on tauri-plugin-sql's database (D11).
//!
//! The plugin's `execute` command runs each call on whichever pooled connection is free, so a
//! `BEGIN` sent from TypeScript and its `COMMIT` can land on different connections. This command
//! takes the plugin's pool for the database `Database.load` opened and runs the whole batch in an
//! sqlx transaction: all statements commit together, and a failing one rolls them all back.
//! It runs the same SQL the plugin's `sql:allow-execute` already lets the WebView send.

use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::{Pool, Sqlite};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

/// One statement and its positional (`?`) parameters.
#[derive(Debug, Deserialize)]
pub struct Statement {
    sql: String,
    #[serde(default)]
    params: Vec<JsonValue>,
}

#[tauri::command]
pub async fn sql_execute_batch(
    db_instances: State<'_, DbInstances>,
    db: String,
    statements: Vec<Statement>,
) -> Result<(), String> {
    let instances = db_instances.0.read().await;
    // The plugin's `DbPool::sqlite()` accessor is commented out in 2.6, so match the variant.
    let Some(DbPool::Sqlite(pool)) = instances.get(&db) else {
        return Err(format!("database {db} is not loaded"));
    };
    execute_batch(pool, statements)
        .await
        .map_err(|e| e.to_string())
}

/// Runs `statements` in order in one transaction. Dropping an uncommitted sqlx transaction (the
/// early return on an error) rolls it back.
pub async fn execute_batch(
    pool: &Pool<Sqlite>,
    statements: Vec<Statement>,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for statement in &statements {
        let mut query = sqlx::query(&statement.sql);
        // Bound as tauri-plugin-sql's `execute` binds them, so a row reads back the same either way.
        for value in &statement.params {
            query = match value {
                JsonValue::Null => query.bind(None::<String>),
                JsonValue::String(s) => query.bind(s.clone()),
                JsonValue::Number(n) => query.bind(n.as_f64().unwrap_or_default()),
                JsonValue::Bool(b) => query.bind(i64::from(*b)),
                other => query.bind(other.to_string()),
            };
        }
        query.execute(&mut *tx).await?;
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;
    use tauri::async_runtime::block_on;

    fn statement(sql: &str, params: Vec<JsonValue>) -> Statement {
        Statement {
            sql: sql.to_string(),
            params,
        }
    }

    async fn count(pool: &Pool<Sqlite>, table: &str) -> i64 {
        sqlx::query(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(pool)
            .await
            .unwrap()
            .get::<i64, _>(0)
    }

    /// A pool of several connections, as tauri-plugin-sql opens: a failing batch leaves nothing.
    #[test]
    fn a_failing_statement_rolls_back_the_whole_batch() {
        let dir = std::env::temp_dir().join(format!("flash-sql-batch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(4)
                .connect_with(
                    SqliteConnectOptions::new()
                        .filename(&path)
                        .create_if_missing(true),
                )
                .await
                .unwrap();
            sqlx::query("CREATE TABLE events (id TEXT PRIMARY KEY, seq INTEGER NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();

            let failing = vec![
                statement(
                    "INSERT INTO events (id, seq) VALUES (?, ?)",
                    vec![json!("e1"), json!(1)],
                ),
                // NOT NULL violation, like a meta write that fails.
                statement(
                    "INSERT INTO kv (key, value_json) VALUES (?, ?)",
                    vec![json!("m"), JsonValue::Null],
                ),
            ];
            assert!(execute_batch(&pool, failing).await.is_err());
            assert_eq!(count(&pool, "events").await, 0);
            assert_eq!(count(&pool, "kv").await, 0);

            let ok = vec![
                statement(
                    "INSERT INTO events (id, seq) VALUES (?, ?)",
                    vec![json!("e1"), json!(1)],
                ),
                statement(
                    "INSERT INTO kv (key, value_json) VALUES (?, ?)",
                    vec![json!("m"), json!("{}")],
                ),
            ];
            execute_batch(&pool, ok).await.unwrap();
            assert_eq!(count(&pool, "events").await, 1);
            let seq: i64 = sqlx::query("SELECT seq FROM events WHERE id = 'e1'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get(0);
            assert_eq!(seq, 1);
            assert_eq!(count(&pool, "kv").await, 1);
            pool.close().await;
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
