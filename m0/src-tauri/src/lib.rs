//! Cœur Rust du prototype M0 : uniquement ce qu'aucun plugin Tauri ne couvre
//! (serveur des hooks Claude Code, coffre Windows, anti-veille, tray).

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

const SECRET_SERVICE: &str = "codbot-m0";
/// Délai max d'attente d'une décision de permission (le hook a un timeout de 600 s).
const DECISION_TIMEOUT: Duration = Duration::from_secs(590);

struct Hooks {
    port: u16,
    token: String,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
}

struct Awake(Mutex<Option<keepawake::KeepAwake>>);

#[derive(serde::Serialize, Clone)]
struct HookEvent {
    id: String,
    event: String,
    payload: Value,
    blocking: bool,
}

/// Serveur HTTP local (127.0.0.1, port aléatoire, jeton) qui reçoit les hooks.
/// Un `PreToolUse` envoyé avec `decide=1` reste bloqué jusqu'à la décision de l'interface.
fn start_hook_server(app: AppHandle) -> Arc<Hooks> {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("serveur des hooks");
    let port = server.server_addr().to_ip().expect("adresse IP").port();
    let hooks = Arc::new(Hooks {
        port,
        token: uuid::Uuid::new_v4().to_string(),
        pending: Mutex::new(HashMap::new()),
    });
    let shared = hooks.clone();
    thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            let hooks = shared.clone();
            thread::spawn(move || {
                let url = req.url().to_string();
                if !url.contains(&format!("token={}", hooks.token)) {
                    let _ = req.respond(tiny_http::Response::from_string("forbidden").with_status_code(403));
                    return;
                }
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let event = payload["hook_event_name"].as_str().unwrap_or("unknown").to_string();
                let blocking = event == "PreToolUse" && url.contains("decide=1");
                let id = uuid::Uuid::new_v4().to_string();

                let reply = if blocking {
                    let (tx, rx) = mpsc::channel();
                    hooks.pending.lock().unwrap().insert(id.clone(), tx);
                    let _ = app.emit("hook", HookEvent { id: id.clone(), event, payload, blocking });
                    let decision = rx
                        .recv_timeout(DECISION_TIMEOUT)
                        .unwrap_or_else(|_| json!({ "behavior": "deny", "reason": "Pas de réponse dans le délai" }));
                    hooks.pending.lock().unwrap().remove(&id);
                    json!({ "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": decision["behavior"],
                        "permissionDecisionReason": decision["reason"],
                    }})
                } else {
                    let _ = app.emit("hook", HookEvent { id, event, payload, blocking });
                    json!({})
                };
                let header: tiny_http::Header = "Content-Type: application/json".parse().unwrap();
                let _ = req.respond(tiny_http::Response::from_string(reply.to_string()).with_header(header));
            });
        }
    });
    hooks
}

fn curl_hook(hooks: &Hooks, decide: bool) -> Value {
    let url = format!(
        "http://127.0.0.1:{}/hook?token={}{}",
        hooks.port,
        hooks.token,
        if decide { "&decide=1" } else { "" }
    );
    json!({
        "type": "command",
        "command": format!("curl -s -m 600 -X POST -H \"Content-Type: application/json\" --data-binary @- \"{url}\""),
        "timeout": 600,
    })
}

/// Écrit le fichier de settings du run (passé à `claude --settings`) et renvoie son chemin.
/// La config globale de l'utilisateur n'est jamais modifiée.
#[tauri::command]
fn prepare_run_settings(app: AppHandle, hooks: State<Arc<Hooks>>, decide_permissions: bool) -> Result<String, String> {
    let notify = json!([{ "hooks": [curl_hook(&hooks, false)] }]);
    let notify_all = json!([{ "matcher": "*", "hooks": [curl_hook(&hooks, false)] }]);
    let settings = json!({ "hooks": {
        "PreToolUse": [{ "matcher": "*", "hooks": [curl_hook(&hooks, decide_permissions)] }],
        "PostToolUse": notify_all,
        "SessionStart": notify,
        "Notification": notify,
        "Stop": notify,
    }});
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("run-{}.settings.json", uuid::Uuid::new_v4()));
    std::fs::write(&path, settings.to_string()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn resolve_hook(hooks: State<Arc<Hooks>>, id: String, behavior: String, reason: Option<String>) -> bool {
    match hooks.pending.lock().unwrap().remove(&id) {
        Some(tx) => tx.send(json!({ "behavior": behavior, "reason": reason.unwrap_or_default() })).is_ok(),
        None => false,
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    keyring::Entry::new(SECRET_SERVICE, &key)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match keyring::Entry::new(SECRET_SERVICE, &key).and_then(|e| e.get_password()) {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match keyring::Entry::new(SECRET_SERVICE, &key).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keep_awake(state: State<Awake>, on: bool) -> Result<bool, String> {
    let mut guard = state.0.lock().unwrap();
    if on && guard.is_none() {
        let handle = keepawake::Builder::default()
            .display(false)
            .idle(true)
            .sleep(true)
            .reason("Codbot : file d'agents active")
            .app_name("Codbot")
            .app_reverse_domain("com.cbm.codbot")
            .create()
            .map_err(|e| e.to_string())?;
        *guard = Some(handle);
    } else if !on {
        *guard = None;
    }
    Ok(guard.is_some())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(start_hook_server(app.handle().clone()));
            app.manage(Awake(Mutex::new(None)));

            let show = MenuItem::with_id(app, "show", "Afficher", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Codbot M0")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // Fermer la fenêtre la cache dans le tray : l'orchestrateur continue de tourner.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            prepare_run_settings,
            resolve_hook,
            secret_set,
            secret_get,
            secret_delete,
            keep_awake
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
