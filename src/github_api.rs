//! GitHub REST API as a feed source.
//!
//! The Atom feeds on github.com cover commits of one branch (and those are
//! already up to date); the account activity feed comes from GitHub's
//! events, which can lag by days. The REST API gives what the feeds do not,
//! without delay: issues, pull requests, releases, new branches and tags,
//! and commits of private repositories. Use the API URL as a feed:
//!
//! | URL | Entries |
//! |-----|---------|
//! | `https://api.github.com/repos/OWNER/REPO/commits?sha=BRANCH` | commits |
//! | `https://api.github.com/repos/OWNER/REPO/issues?state=all&sort=created` | issues and PRs |
//! | `https://api.github.com/user/issues?filter=all&state=all&sort=created` | issues and PRs of all your repos (token) |
//! | `https://api.github.com/repos/OWNER/REPO/pulls?state=all&sort=created&direction=desc` | PRs |
//! | `https://api.github.com/repos/OWNER/REPO/releases` | releases |
//! | `https://api.github.com/repos/OWNER/REPO/branches` | new branches |
//! | `https://api.github.com/repos/OWNER/REPO/tags` | new tags |
//!
//! `Auth.GitHubToken` (e.g. `"${GITHUB_TOKEN}"`) is sent only to
//! api.github.com: 5000 requests/hour instead of 60, and private repos.
//! XFeeder only reads (GET). Unchanged answers (HTTP 304) do not count
//! against the limit.

use serde_json::{Value, json};

use crate::js::{self, get};
use crate::parsers::Body;

pub const HOST: &str = "api.github.com";

pub fn is_api(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .is_some_and(|u| u.scheme() == "https" && u.host_str() == Some(HOST))
}

/// Request headers for api.github.com (the token only when configured).
pub fn headers(root: &Value) -> Vec<(String, String)> {
    let mut out = vec![
        (
            "accept".to_string(),
            "application/vnd.github+json".to_string(),
        ),
        ("x-github-api-version".to_string(), "2022-11-28".to_string()),
    ];
    if let Some(token) = js::trimmed_str(js::path(root, &["Auth", "GitHubToken"]))
        .filter(|t| !t.is_empty() && !t.starts_with("${"))
    {
        out.push(("authorization".to_string(), format!("Bearer {token}")));
    }
    out
}

/// Markdown from GitHub kept as it is, minus issue-template comments and
/// runs of blank lines.
fn plain(text: &str) -> String {
    static COMMENT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?s)<!--.*?-->").unwrap());
    static BLANK: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\n[ \t]*\n(?:[ \t]*\n)+").unwrap());
    let text = COMMENT
        .replace_all(&text.replace("\r\n", "\n"), "")
        .into_owned();
    BLANK.replace_all(&text, "\n\n").trim().to_string()
}

fn s(value: &Value) -> String {
    js::to_string_or_empty(value)
}

/// `OWNER/REPO` and the rest of the path for `/repos/OWNER/REPO/...`.
fn repo_path(url: &url::Url) -> Option<(String, Vec<String>)> {
    let parts: Vec<String> = url.path_segments()?.map(str::to_string).collect();
    (parts.len() >= 4 && parts[0] == "repos")
        .then(|| (format!("{}/{}", parts[1], parts[2]), parts[3..].to_vec()))
}

fn query(url: &url::Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

fn first_line(text: &str) -> (String, String) {
    let mut lines = text.splitn(2, '\n');
    let head = lines.next().unwrap_or("").trim().to_string();
    let rest = lines.next().unwrap_or("").trim().to_string();
    (head, rest)
}

fn commit(item: &Value, repo: &str, branch: Option<&str>) -> Option<Value> {
    let link = s(get(item, "html_url"));
    if link.is_empty() {
        return None;
    }
    let (title, rest) = first_line(&s(js::path(item, &["commit", "message"])));
    let author = js::or(&[
        js::path(item, &["author", "login"]),
        js::path(item, &["commit", "author", "name"]),
    ])
    .clone();
    let place = match branch {
        Some(b) => format!("{repo} @ {b}"),
        None => repo.to_string(),
    };
    let sha: String = s(get(item, "sha")).chars().take(7).collect();
    let body = if rest.is_empty() {
        format!("📦 {place} • {sha}")
    } else {
        format!("📦 {place} • {sha}\n\n{rest}")
    };
    Some(json!({
        "title": title,
        "link": link,
        "guid": link,
        "contentSnippet": plain(&body),
        "isoDate": s(js::path(item, &["commit", "committer", "date"])),
        "author": author,
        "enclosure": get(js::path(item, &["author"]), "avatar_url"),
        "categories": ["github", "commit"],
    }))
}

fn issue(item: &Value, repo: Option<&str>) -> Option<Value> {
    let link = s(get(item, "html_url"));
    if link.is_empty() {
        return None;
    }
    let repo = repo
        .map(str::to_string)
        .unwrap_or_else(|| s(js::path(item, &["repository", "full_name"])));
    let is_pr = !get(item, "pull_request").is_null() || !get(item, "head").is_null();
    let (icon, kind) = if is_pr {
        ("🔀", "Pull request")
    } else {
        ("🐞", "Issue")
    };
    let number = s(get(item, "number"));
    let user = s(js::path(item, &["user", "login"]));
    let body = s(get(item, "body"));
    let mut text = format!("{icon} {kind} #{number} in {repo}");
    if !body.trim().is_empty() {
        text.push_str("\n\n");
        text.push_str(&body);
    }
    Some(json!({
        "title": s(get(item, "title")),
        "link": link,
        "guid": link,
        "contentSnippet": plain(&text),
        "isoDate": s(get(item, "created_at")),
        "author": user,
        "enclosure": js::path(item, &["user", "avatar_url"]),
        "categories": ["github", if is_pr { "pull" } else { "issue" }],
    }))
}

fn release(item: &Value, repo: &str) -> Option<Value> {
    let link = s(get(item, "html_url"));
    if link.is_empty() || get(item, "draft") == &Value::Bool(true) {
        return None;
    }
    let tag = s(get(item, "tag_name"));
    let name = s(get(item, "name"));
    let pre = if get(item, "prerelease") == &Value::Bool(true) {
        " (pre-release)"
    } else {
        ""
    };
    let mut text = format!("🚀 Release {tag}{pre} of {repo}");
    let body = s(get(item, "body"));
    if !body.trim().is_empty() {
        text.push_str("\n\n");
        text.push_str(&body);
    }
    Some(json!({
        "title": if name.trim().is_empty() { tag.clone() } else { name },
        "link": link,
        "guid": link,
        "contentSnippet": plain(&text),
        "isoDate": s(js::or(&[get(item, "published_at"), get(item, "created_at")])),
        "author": js::path(item, &["author", "login"]),
        "enclosure": js::path(item, &["author", "avatar_url"]),
        "categories": ["github", "release"],
    }))
}

/// Branches and tags carry no date: they are new when first seen (the
/// first check only records them, as with any new feed).
fn reference(item: &Value, repo: &str, tag: bool) -> Option<Value> {
    let name = s(get(item, "name"));
    if name.is_empty() {
        return None;
    }
    let link = if tag {
        format!("https://github.com/{repo}/releases/tag/{name}")
    } else {
        format!("https://github.com/{repo}/tree/{name}")
    };
    let sha: String = s(js::path(item, &["commit", "sha"]))
        .chars()
        .take(7)
        .collect();
    let what = if tag {
        "🏷️ New tag"
    } else {
        "🌿 New branch"
    };
    Some(json!({
        "title": format!("{what} {name} in {repo}"),
        "link": link,
        "guid": format!("{link}#{}", if tag { "tag" } else { "branch" }),
        "contentSnippet": format!("{what} {name} in {repo} • {sha}"),
        "categories": ["github", if tag { "tag" } else { "branch" }],
    }))
}

/// Parser for api.github.com list endpoints.
pub fn parse(url: &str, body: &Body) -> Vec<Value> {
    if !is_api(url) {
        return Vec::new();
    }
    let (Ok(parsed), Some(Value::Array(items))) = (url::Url::parse(url), body.json.as_ref()) else {
        return Vec::new();
    };
    let user_issues = matches!(parsed.path(), "/user/issues" | "/issues");
    let route = repo_path(&parsed);
    let map = |item: &Value| -> Option<Value> {
        if user_issues {
            return issue(item, None);
        }
        let (repo, rest) = route.as_ref()?;
        match rest.first().map(String::as_str) {
            Some("commits") if rest.len() == 1 => {
                commit(item, repo, query(&parsed, "sha").as_deref())
            }
            Some("issues" | "pulls") if rest.len() == 1 => issue(item, Some(repo)),
            Some("releases") if rest.len() == 1 => release(item, repo),
            Some("branches") if rest.len() == 1 => reference(item, repo, false),
            Some("tags") if rest.len() == 1 => reference(item, repo, true),
            _ => None,
        }
    };
    items.iter().filter_map(map).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(value: Value) -> Body {
        Body::new(value.to_string())
    }

    #[test]
    fn commits_issues_releases_branches() {
        let commits = parse(
            "https://api.github.com/repos/yhymid/XFeeder/commits?sha=3.0-beta",
            &body(json!([{
                "sha": "6cebcde0123456",
                "html_url": "https://github.com/yhymid/XFeeder/commit/6cebcde0123456",
                "commit": { "message": "Merge Steam posts\n\nLonger text.\n\nCo-Authored-By: x", "committer": { "date": "2026-11-21T02:24:26Z" }, "author": { "name": "yhym" } },
                "author": { "login": "yhymid", "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4" }
            }])),
        );
        assert_eq!(commits[0]["title"], "Merge Steam posts");
        assert_eq!(commits[0]["author"], "yhymid");
        assert!(
            commits[0]["contentSnippet"]
                .as_str()
                .unwrap()
                .starts_with("📦 yhymid/XFeeder @ 3.0-beta • 6cebcde")
        );

        let issues = parse(
            "https://api.github.com/user/issues?filter=all&state=all",
            &body(json!([
                { "html_url": "https://github.com/yhymid/XUninstaller/issues/6", "number": 6, "title": "Crash", "body": "Steps", "created_at": "2026-11-14T03:27:50Z", "user": { "login": "a", "avatar_url": "https://avatars.githubusercontent.com/u/2?v=4" }, "repository": { "full_name": "yhymid/XUninstaller" } },
                { "html_url": "https://github.com/yhymid/XFeeder/pull/7", "number": 7, "title": "PR", "body": null, "created_at": "2026-11-15T00:00:00Z", "user": { "login": "b" }, "pull_request": {}, "repository": { "full_name": "yhymid/XFeeder" } }
            ])),
        );
        assert_eq!(
            issues[0]["contentSnippet"],
            "🐞 Issue #6 in yhymid/XUninstaller\n\nSteps"
        );
        assert_eq!(
            issues[1]["contentSnippet"],
            "🔀 Pull request #7 in yhymid/XFeeder"
        );

        let releases = parse(
            "https://api.github.com/repos/yhymid/XUninstaller/releases",
            &body(json!([
                { "html_url": "https://github.com/yhymid/XUninstaller/releases/tag/v0.1.0", "tag_name": "v0.1.0", "name": "", "body": "Notes", "published_at": "2026-11-14T00:00:00Z", "author": { "login": "yhymid" } },
                { "html_url": "https://x/draft", "tag_name": "v9", "draft": true }
            ])),
        );
        assert_eq!(releases.len(), 1, "drafts skipped");
        assert_eq!(plain("a\r\n<!-- template -->\r\n\r\n\r\n\r\nb"), "a\n\nb");
        assert_eq!(releases[0]["title"], "v0.1.0");

        let branches = parse(
            "https://api.github.com/repos/yhymid/XFeeder/branches",
            &body(json!([{ "name": "3.0-beta", "commit": { "sha": "abcdef123" } }])),
        );
        assert_eq!(
            branches[0]["link"],
            "https://github.com/yhymid/XFeeder/tree/3.0-beta"
        );
        assert_eq!(
            branches[0]["title"],
            "🌿 New branch 3.0-beta in yhymid/XFeeder"
        );

        // Other hosts and unknown endpoints are left to the other parsers.
        assert!(parse("https://example.com/repos/a/b/commits", &body(json!([{}]))).is_empty());
        assert!(
            parse(
                "https://api.github.com/repos/a/b/events",
                &body(json!([{ "id": "1" }]))
            )
            .is_empty()
        );
    }

    #[test]
    fn token_only_when_configured() {
        let none = headers(&json!({}));
        assert!(none.iter().all(|(k, _)| k != "authorization"));
        let unresolved = headers(&json!({ "Auth": { "GitHubToken": "${GITHUB_TOKEN}" } }));
        assert!(unresolved.iter().all(|(k, _)| k != "authorization"));
        let set = headers(&json!({ "Auth": { "GitHubToken": "abc" } }));
        assert!(set.contains(&("authorization".into(), "Bearer abc".into())));
    }
}
