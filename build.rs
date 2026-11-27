//! Records the git commit the binary was built from (shown by the dashboard).
use std::process::Command;

fn main() {
    // A container build has no .git: the commit comes as a build argument.
    let given = std::env::var("XFEEDER_GIT_COMMIT")
        .ok()
        .map(|c| c.trim().chars().take(7).collect::<String>())
        .filter(|c| !c.is_empty() && c.chars().all(|ch| ch.is_ascii_hexdigit()));
    println!("cargo:rerun-if-env-changed=XFEEDER_GIT_COMMIT");
    let commit = given
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "--short=7", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|c| !c.is_empty() && c.chars().all(|ch| ch.is_ascii_hexdigit()))
        })
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=XFEEDER_GIT_COMMIT={commit}");
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/heads");
}
