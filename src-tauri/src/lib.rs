//! Cœur Rust de Codbot : uniquement ce qu'aucun plugin Tauri ne couvre
//! (serveur des hooks Claude Code, coffre Windows, anti-veille, tray, schéma SQLite).

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

const SECRET_SERVICE: &str = "codbot";
/// Délai max d'attente d'une décision de permission (le hook a un timeout de 600 s).
const DECISION_TIMEOUT: Duration = Duration::from_secs(590);

struct Hooks {
    port: u16,
    /// Un jeton par run : un hook ne peut parler qu'au nom du run pour lequel il a été écrit.
    tokens: Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
}

struct Awake(Mutex<Option<keepawake::KeepAwake>>);

#[derive(serde::Serialize, Clone)]
struct HookEvent {
    id: String,
    run_id: String,
    event: String,
    payload: Value,
    blocking: bool,
}

fn query_param(url: &str, name: &str) -> String {
    url.split(['?', '&'])
        .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
        .unwrap_or_default()
        .to_string()
}

/// Identifiant du run si l'URL porte le jeton de ce run, sinon None.
fn authorized_run(tokens: &HashMap<String, String>, url: &str) -> Option<String> {
    let run_id = query_param(url, "run");
    let token = query_param(url, "token");
    match tokens.get(&run_id) {
        Some(expected) if !token.is_empty() && *expected == token => Some(run_id),
        _ => None,
    }
}

/// Serveur HTTP local (127.0.0.1, port aléatoire, jeton par run) qui reçoit les hooks.
/// Un `PreToolUse` envoyé avec `decide=1` reste bloqué jusqu'à la décision de l'interface.
fn start_hook_server(app: AppHandle) -> Arc<Hooks> {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("serveur des hooks");
    let port = server.server_addr().to_ip().expect("adresse IP").port();
    let hooks = Arc::new(Hooks {
        port,
        tokens: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
    });
    let shared = hooks.clone();
    thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            let hooks = shared.clone();
            thread::spawn(move || {
                let url = req.url().to_string();
                let Some(run_id) = authorized_run(&hooks.tokens.lock().unwrap(), &url) else {
                    let _ = req.respond(tiny_http::Response::from_string("forbidden").with_status_code(403));
                    return;
                };
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let event = payload["hook_event_name"].as_str().unwrap_or("unknown").to_string();
                let blocking = event == "PreToolUse" && query_param(&url, "decide") == "1";
                let id = uuid::Uuid::new_v4().to_string();

                let reply = if blocking {
                    let (tx, rx) = mpsc::channel();
                    hooks.pending.lock().unwrap().insert(id.clone(), tx);
                    let _ = app.emit("hook", HookEvent { id: id.clone(), run_id, event, payload, blocking });
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
                    let _ = app.emit("hook", HookEvent { id, run_id, event, payload, blocking });
                    json!({})
                };
                let header: tiny_http::Header = "Content-Type: application/json".parse().unwrap();
                let _ = req.respond(tiny_http::Response::from_string(reply.to_string()).with_header(header));
            });
        }
    });
    hooks
}

fn curl_hook(port: u16, token: &str, run_id: &str, decide: bool) -> Value {
    let url = format!(
        "http://127.0.0.1:{port}/hook?token={token}&run={run_id}{}",
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
fn prepare_run_settings(app: AppHandle, hooks: State<Arc<Hooks>>, run_id: String) -> Result<String, String> {
    // Nouveau jeton à chaque (re)lancement de session : l'ancien fichier de settings ne vaut plus rien.
    let token = uuid::Uuid::new_v4().to_string();
    hooks.tokens.lock().unwrap().insert(run_id.clone(), token.clone());
    let hook = |decide| curl_hook(hooks.port, &token, &run_id, decide);
    let notify = json!([{ "hooks": [hook(false)] }]);
    let notify_all = json!([{ "matcher": "*", "hooks": [hook(false)] }]);
    let settings = json!({ "hooks": {
        "PreToolUse": [{ "matcher": "*", "hooks": [hook(true)] }],
        "PostToolUse": notify_all,
        "SessionStart": notify,
        "Notification": notify,
        "Stop": notify,
    }});
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("run-{run_id}.settings.json"));
    std::fs::write(&path, settings.to_string()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Run terminé : son jeton est révoqué et son fichier de settings supprimé.
#[tauri::command]
fn revoke_run(app: AppHandle, hooks: State<Arc<Hooks>>, run_id: String) {
    hooks.tokens.lock().unwrap().remove(&run_id);
    if let Ok(dir) = app.path().app_cache_dir() {
        let _ = std::fs::remove_file(dir.join(format!("run-{run_id}.settings.json")));
    }
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
            .reason("Codbot : agents actifs")
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

/// Nom de ce PC (verrous multi-PC dans ClickUp).
#[tauri::command]
fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "pc".into())
}

/// Lecture et écriture d'un fichier choisi par l'utilisateur dans une boîte de dialogue (export des réglages).
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

/// Vérifie les arguments avant de lancer un terminal : identifiant de session UUID, dossier existant.
fn terminal_args(cwd: &str, session_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(session_id).map_err(|_| format!("identifiant de session invalide : {session_id}"))?;
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("dossier introuvable : {cwd}"));
    }
    Ok(())
}

/// Ouvre la session d'un run dans un terminal interactif (`claude --resume`), dans son worktree.
/// Windows Terminal s'il est installé, sinon une console classique.
#[tauri::command]
fn open_claude_terminal(cwd: String, session_id: String) -> Result<(), String> {
    use std::process::Command;
    terminal_args(&cwd, &session_id)?;
    if Command::new("wt").args(["-d", &cwd, "claude", "--resume", &session_id]).spawn().is_ok() {
        return Ok(());
    }
    Command::new("cmd")
        .args(["/c", "start", "Codbot", "/D", &cwd, "cmd", "/k", "claude", "--resume", &session_id])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "schema initial",
            kind: MigrationKind::Up,
            sql: include_str!("../migrations/001_init.sql"),
        },
        Migration {
            version: 2,
            description: "branches et PR",
            kind: MigrationKind::Up,
            sql: include_str!("../migrations/002_branches.sql"),
        },
        Migration {
            version: 3,
            description: "statut initial des taches",
            kind: MigrationKind::Up,
            sql: include_str!("../migrations/003_initial_status.sql"),
        },
        Migration {
            version: 4,
            description: "file d'attente",
            kind: MigrationKind::Up,
            sql: include_str!("../migrations/004_queue.sql"),
        },
        Migration {
            version: 5,
            description: "mode des statuts par run",
            kind: MigrationKind::Up,
            sql: include_str!("../migrations/005_status_mode.sql"),
        },
        Migration {
            version: 6,
            description: "modele et effort par run",
            kind: MigrationKind::Up,
            sql: include_str!("../migrations/006_model.sql"),
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Une seule instance par PC : relancer l'app ramène la fenêtre existante (une file ne tourne jamais deux fois).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:codbot.db", migrations())
                .build(),
        )
        .setup(|app| {
            app.manage(start_hook_server(app.handle().clone()));
            app.manage(Awake(Mutex::new(None)));

            let show = MenuItem::with_id(app, "show", "Afficher", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Codbot")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // Fermer la fenêtre la cache dans le tray : les runs continuent.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            prepare_run_settings,
            revoke_run,
            resolve_hook,
            secret_set,
            secret_get,
            secret_delete,
            keep_awake,
            machine_name,
            open_claude_terminal,
            read_text_file,
            write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_hook_ne_parle_qu_au_nom_de_son_run() {
        let tokens = HashMap::from([("r1".to_string(), "t1".to_string()), ("r2".to_string(), "t2".to_string())]);
        assert_eq!(authorized_run(&tokens, "/hook?token=t1&run=r1&decide=1"), Some("r1".into()));
        assert_eq!(authorized_run(&tokens, "/hook?token=t2&run=r1"), None, "jeton d'un autre run");
        assert_eq!(authorized_run(&tokens, "/hook?token=t1&run=r9"), None, "run inconnu ou révoqué");
        assert_eq!(authorized_run(&tokens, "/hook?run=r1"), None, "sans jeton");
        assert_eq!(authorized_run(&HashMap::new(), "/hook?token=&run="), None, "tout vide");
    }

    #[test]
    fn le_terminal_refuse_des_arguments_douteux() {
        let dir = std::env::temp_dir();
        let dir = dir.to_str().unwrap();
        assert!(terminal_args(dir, "3c7b7ac0-f07f-4ed2-acf8-ccde5050ae6e").is_ok());
        assert!(terminal_args(dir, "x & calc").is_err(), "session non UUID");
        assert!(terminal_args("C:\\nexiste\\pas", "3c7b7ac0-f07f-4ed2-acf8-ccde5050ae6e").is_err());
    }
}
