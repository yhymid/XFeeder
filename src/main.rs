//! XFeeder — RSS/Atom/JSON/YouTube/Discord feed relay to Discord webhooks
//! (Components V2) and Telegram, with an optional web dashboard.

mod adaptive;
mod app;
mod clearance;
mod config;
mod dashboard;
mod deliver;
mod diag;
mod diagnostics;
mod feed;
mod filter;
mod http;
mod js;
mod parsers;
mod preview;
#[cfg(test)]
mod profile_tests;
mod scrapling;
mod solver;
mod state;
mod telemetry;
mod text;
mod xmltree;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const HELP: &str = "Usage: xfeeder [run] [options]
       xfeeder dashboard [--data-dir DIR]
       xfeeder preview <URL>... [--profile NAME] [--bench N]   (see xfeeder preview --help)

Worker options:
  --dry-run       Simulate deliveries without persisting cache changes.
  --once          Run one pass over all channels and exit.
  --check-config  Validate config and print summary without starting the queue.
  --debug-expert  Print detailed diagnostics with secrets redacted.
  --config PATH   Use a custom config.json path (default ./config.json).
  --cache PATH    Use a custom cache.json path (default ./cache.json).
  --version       Print the version.
  --help          Show this help.

Dashboard (XFEEDER_DASHBOARD_HOST, XFEEDER_DASHBOARD_PORT, XFEEDER_DASHBOARD_PASSWORD,
XFEEDER_DASHBOARD_PUBLIC_ORIGIN):
  --data-dir DIR  Directory with config.json, .env and cache.json (default .).";

struct Options {
    config: PathBuf,
    cache: PathBuf,
    dry_run: bool,
    once: bool,
    check: bool,
    expert: bool,
    diagnostics: bool,
}

/// Process environment first, then `.env` next to the config (like dotenv).
fn env_flag(env: &config::Env, name: &str) -> bool {
    env.get(name).is_some_and(|v| v == "1")
}

pub async fn shutdown_signal() -> &'static str {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => "SIGTERM",
        _ = int.recv() => "SIGINT",
    }
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let preview = args.first().map(String::as_str) == Some("preview");
    if !preview && args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("xfeeder {VERSION}");
        return ExitCode::SUCCESS;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    if preview {
        args.remove(0);
        return runtime.block_on(preview::run(args));
    }
    if args.first().map(String::as_str) == Some("dashboard") {
        args.remove(0);
        return runtime.block_on(run_dashboard(args));
    }
    if args.first().map(String::as_str) == Some("run") {
        args.remove(0);
    }
    let mut options = Options {
        config: PathBuf::from("./config.json"),
        cache: PathBuf::from("./cache.json"),
        dry_run: false,
        once: false,
        check: false,
        expert: false,
        diagnostics: false,
    };
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--dry-run" => options.dry_run = true,
            "--once" => options.once = true,
            "--check-config" => options.check = true,
            "--debug-expert" => options.expert = true,
            "--config" | "--cache" => match iter.next() {
                Some(value) if arg == "--config" => options.config = PathBuf::from(value),
                Some(value) => options.cache = PathBuf::from(value),
                None => {
                    eprintln!("{arg} requires a path");
                    return ExitCode::from(2);
                }
            },
            other => {
                eprintln!("Unknown argument: {other}\n\n{HELP}");
                return ExitCode::from(2);
            }
        }
    }
    let env = config::env_for(&options.config);
    options.dry_run |= env_flag(&env, "XFEEDER_DRY_RUN");
    options.once |= env_flag(&env, "XFEEDER_RUN_ONCE");
    options.expert |= env_flag(&env, "XFEEDER_DEBUG_EXPERT");
    options.diagnostics = env_flag(&env, "XFEEDER_DIAGNOSTICS");
    runtime.block_on(run_worker(options))
}

async fn run_dashboard(args: Vec<String>) -> ExitCode {
    let mut data_dir = PathBuf::from(".");
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match (arg.as_str(), iter.next()) {
            ("--data-dir", Some(dir)) => data_dir = PathBuf::from(dir),
            _ => {
                eprintln!("{HELP}");
                return ExitCode::from(2);
            }
        }
    }
    let data_dir = config::absolute(&data_dir);
    let env = config::env_for(&data_dir.join("config.json"));
    let var = |name: &str| {
        env.get(name)
            .map(|v| v.trim().to_string())
            .unwrap_or_default()
    };
    let options = dashboard::Options {
        host: Some(var("XFEEDER_DASHBOARD_HOST"))
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| "127.0.0.1".into()),
        port: var("XFEEDER_DASHBOARD_PORT").parse().unwrap_or(3000),
        data_dir,
        public_origin: var("XFEEDER_DASHBOARD_PUBLIC_ORIGIN"),
        password: var("XFEEDER_DASHBOARD_PASSWORD"),
        session_ttl_hours: var("XFEEDER_DASHBOARD_SESSION_TTL_HOURS").parse().ok(),
    };
    match dashboard::serve(options).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[Dashboard] {}", diag::sanitize_text(&error));
            ExitCode::FAILURE
        }
    }
}

async fn run_worker(options: Options) -> ExitCode {
    diag::set_expert(options.expert);
    let queue = !options.once && !options.check;
    if queue {
        telemetry::enable();
    }
    let modes: Vec<&str> = [
        (options.dry_run, "dry-run"),
        (options.once, "once"),
        (options.check, "check-config"),
        (options.expert, "debug-expert"),
    ]
    .into_iter()
    .filter_map(|(on, name)| on.then_some(name))
    .collect();
    println!(
        "XFeeder v{VERSION} started{}.",
        if modes.is_empty() {
            String::new()
        } else {
            format!(" ({})", modes.join(", "))
        }
    );

    if options.check {
        return match config::load(&options.config) {
            Ok(config) => {
                println!("{}", serde_json::to_string_pretty(&json!({
                    "channels": config.channels.len(),
                    "warnings": config::validate_channels(&config.channels).iter().map(|w| diag::sanitize_text(w)).collect::<Vec<_>>(),
                    "dryRun": options.dry_run,
                    "configPath": options.config,
                    "cachePath": options.cache,
                })).unwrap_or_default());
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("[Startup Error] {}", diag::sanitize_text(&error));
                ExitCode::FAILURE
            }
        };
    }

    let app = match app::App::new(
        &options.config,
        &options.cache,
        options.dry_run,
        options.expert,
    ) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("[Startup Error] {}", diag::sanitize_text(&error));
            return ExitCode::FAILURE;
        }
    };
    let diagnostics_task = match diagnostics::Options::from_settings(
        app.config().settings(),
        &app.base,
        options.diagnostics,
    ) {
        Some(diag_options) => match diagnostics::init(diag_options) {
            Ok(()) => Some(tokio::spawn(async {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                loop {
                    tick.tick().await;
                    let _ = tokio::task::spawn_blocking(diagnostics::sample_process).await;
                }
            })),
            Err(error) => {
                crate::error!("Diagnostics", "Not started: {error}");
                None
            }
        },
        None => None,
    };
    diag::expert(
        "app.start",
        json!({ "dryRun": options.dry_run, "autostart": queue, "once": options.once }),
    );

    if options.once {
        let run = app.run_once();
        tokio::pin!(run);
        let result = tokio::select! {
            result = &mut run => result,
            signal = shutdown_signal() => {
                println!("\n[Shutdown] {signal}: saving state and exiting...");
                app.begin_stop();
                app.cancel.cancel();
                run.await
            }
        };
        scrapling::close().await;
        app.flush().await;
        if let Some(task) = &diagnostics_task {
            task.abort();
        }
        diag::expert(
            "app.shutdown",
            json!({ "dryRun": options.dry_run, "once": true }),
        );
        diagnostics::flush();
        return match result {
            Ok((checked, total)) => {
                println!("[Once] Completed {checked}/{total} channels.");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("[Startup Error] {error:?}");
                ExitCode::FAILURE
            }
        };
    }

    let publisher = Arc::new(telemetry::Publisher {
        config_path: options.config.clone(),
        worker_id: hex::encode(rand::random::<[u8; 16]>()),
    });
    let telemetry_task = {
        let app = app.clone();
        let publisher = publisher.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                if app.stopping() {
                    break;
                }
                app.refresh(true);
                let ready =
                    !app.stopping() && app.state.usable() && !app.config().channels.is_empty();
                let publisher = publisher.clone();
                let _ = tokio::task::spawn_blocking(move || publisher.publish(ready, false)).await;
            }
        })
    };
    let signal_task = {
        let app = app.clone();
        tokio::spawn(async move {
            let signal = shutdown_signal().await;
            println!("\n[Shutdown] {signal}: saving state and exiting...");
            app.begin_stop();
            // A second signal forces immediate cancellation.
            let _ = shutdown_signal().await;
            app.cancel.cancel();
        })
    };

    app::run_queue(app.clone(), Duration::from_secs(30)).await;
    let unsafe_state = !app.state.usable();
    app.begin_stop();
    telemetry_task.abort();
    signal_task.abort();
    http::net().begin_shutdown();
    scrapling::close().await;
    app.flush().await;
    diag::expert("app.shutdown", json!({ "dryRun": options.dry_run }));
    if let Some(task) = &diagnostics_task {
        task.abort();
    }
    diagnostics::flush();
    let _ = tokio::task::spawn_blocking(move || {
        publisher.publish(false, true);
        publisher.retire();
    })
    .await;
    if unsafe_state {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
