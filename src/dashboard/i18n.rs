//! Dashboard language (English / Polish).
//!
//! Pages are rendered in English. With the `xf_lang=pl` cookie (set by
//! `/lang?to=pl`), the finished HTML is translated in one pass: whole text
//! nodes and the `placeholder`, `title` and `aria-label` attributes are
//! looked up in [`EXACT`], then in the [`rules`] for texts with numbers or
//! names. Anything else (channel names, feed titles, URLs, config JSON in
//! `<textarea>`, `<pre>` and `<code>`) is left exactly as it was.

use std::collections::HashMap;
use std::sync::LazyLock;

use axum::http::{HeaderMap, header};
use regex::Regex;

use super::ui::esc;

pub(super) const COOKIE: &str = "xf_lang";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lang {
    En,
    Pl,
}

impl Lang {
    pub(super) fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Pl => "pl",
        }
    }
}

pub(super) fn from_headers(headers: &HeaderMap) -> Lang {
    let polish = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .any(|(name, value)| name == COOKIE && value == "pl");
    if polish { Lang::Pl } else { Lang::En }
}

/// Where `/lang` may send the browser back to: a path on this dashboard.
pub(super) fn safe_back(back: &str) -> &str {
    let ok = back.starts_with('/')
        && !back.starts_with("//")
        && !back.contains('\\')
        && !back.chars().any(char::is_control);
    if ok { back } else { "/" }
}

const EXACT: &[(&str, &str)] = &[
    // Navigation, layout
    ("Overview", "Przegląd"),
    ("Channels", "Kanały"),
    ("Activity", "Aktywność"),
    ("Diagnostics", "Diagnostyka"),
    ("Settings", "Ustawienia"),
    ("Advanced", "Zaawansowane"),
    ("Log out", "Wyloguj"),
    ("Log in", "Zaloguj"),
    ("Dashboard password", "Hasło do dashboardu"),
    ("Back to the overview", "Wróć do przeglądu"),
    ("Forbidden", "Brak dostępu"),
    ("Not found", "Nie znaleziono"),
    (
        "Form posts are accepted only from this dashboard (same origin).",
        "Formularze są przyjmowane tylko z tego dashboardu (ten sam origin).",
    ),
    // Overview
    ("Worker", "Worker"),
    ("Destinations", "Cele"),
    ("Last 24 h", "Ostatnie 24 h"),
    ("Last activity", "Ostatnia aktywność"),
    ("Delivery cache", "Historia wysyłek"),
    ("remembered entries", "zapamiętanych wpisów"),
    ("Worker control", "Sterowanie workerem"),
    ("Configuration", "Konfiguracja"),
    ("Counters", "Liczniki"),
    ("Durations", "Czasy"),
    ("Stage", "Etap"),
    ("count", "liczba"),
    ("Recent activity", "Ostatnia aktywność"),
    ("All activity →", "Cała aktywność →"),
    ("Turn off", "Wyłącz"),
    ("Refresh every 15 s", "Odświeżaj co 15 s"),
    (
        "Auto-refresh is on.",
        "Automatyczne odświeżanie jest włączone.",
    ),
    ("Start", "Uruchom"),
    ("Stop", "Zatrzymaj"),
    ("Restart", "Restartuj"),
    ("Not running", "Nie działa"),
    ("Not ready", "Niegotowy"),
    (
        "Running (started by the dashboard)",
        "Działa (uruchomiony z dashboardu)",
    ),
    (
        "Running (systemd or another process)",
        "Działa (systemd albo inny proces)",
    ),
    ("Worker metrics unavailable", "Metryki workera niedostępne"),
    (
        "Only a worker started here can be stopped or restarted here; a systemd service is managed with systemctl.",
        "Tylko worker uruchomiony tutaj może być tu zatrzymany albo zrestartowany; usługą systemd zarządza się przez systemctl.",
    ),
    ("Unknown worker action.", "Nieznana akcja workera."),
    ("just now", "przed chwilą"),
    ("unknown", "nieznany"),
    ("healthy", "dobry"),
    ("warning", "ostrzeżenia"),
    // Activity
    ("All", "Wszystko"),
    ("Errors", "Błędy"),
    ("Deliveries", "Wysyłki"),
    ("Fetches", "Pobrania"),
    ("Time", "Czas"),
    ("Event", "Zdarzenie"),
    ("Channel", "Kanał"),
    ("Target", "Cel"),
    ("Status", "Status"),
    ("Duration", "Czas trwania"),
    ("Items", "Wpisy"),
    ("Error", "Błąd"),
    (
        "No activity recorded yet (the worker writes it while running).",
        "Nie zapisano jeszcze aktywności (worker zapisuje ją w trakcie działania).",
    ),
    ("No events.", "Brak zdarzeń."),
    ("Sent in the last 24 h:", "Wysłane w ostatnich 24 h:"),
    ("· errors:", "· błędy:"),
    ("· last event:", "· ostatnie zdarzenie:"),
    ("· observed since", "· obserwowane od"),
    // Channels list and form
    ("Add channel", "Dodaj kanał"),
    ("New channel", "Nowy kanał"),
    ("Edit channel", "Edytuj kanał"),
    ("Edit", "Edytuj"),
    ("Duplicate", "Duplikuj"),
    ("Delete", "Usuń"),
    ("Delete channel", "Usuń kanał"),
    ("Cancel", "Anuluj"),
    ("Save", "Zapisz"),
    ("Save channel", "Zapisz kanał"),
    ("Discard changes", "Odrzuć zmiany"),
    ("Name", "Nazwa"),
    ("Group", "Grupa"),
    ("Sources", "Źródła"),
    ("Destination", "Cel"),
    ("Schedule", "Harmonogram"),
    ("Filters", "Filtry"),
    ("Other settings", "Inne ustawienia"),
    ("Feed URLs", "Adresy feedów"),
    ("Webhook URL", "Adres webhooka"),
    ("Thread ID", "ID wątku"),
    ("Discord thread", "Wątek Discorda"),
    ("Check every (minutes)", "Sprawdzaj co (minuty)"),
    ("Check every", "Sprawdzaj co"),
    ("Every", "Co"),
    ("Interval", "Interwał"),
    ("Max entries per run", "Maks. wpisów na obieg"),
    ("Max/run", "Maks./obieg"),
    ("First-run send", "Wysyłka przy pierwszym sprawdzeniu"),
    ("Include (any of)", "Uwzględnij (dowolne z)"),
    ("Exclude", "Wyklucz"),
    ("Fields", "Pola"),
    ("Case-sensitive", "Rozróżniaj wielkość liter"),
    ("Max age (hours)", "Maks. wiek (godziny)"),
    ("Discord", "Discord"),
    ("Discord + Telegram", "Discord + Telegram"),
    ("Telegram", "Telegram"),
    (
        "One URL per line: RSS, Atom, JSON Feed, YouTube or a web page with a feed link.",
        "Jeden adres na linię: RSS, Atom, JSON Feed, YouTube albo strona z linkiem do feedu.",
    ),
    (
        "Forum or thread to post into (optional).",
        "Forum albo wątek, do którego pisać (opcjonalnie).",
    ),
    ("Empty = default (30).", "Puste = domyślnie (30)."),
    ("Empty = default (5).", "Puste = domyślnie (5)."),
    (
        "Newest N entries posted when a feed is first seen. Empty = global setting.",
        "Tyle najnowszych wpisów idzie przy pierwszym zobaczeniu feedu. Puste = ustawienie globalne.",
    ),
    (
        "Newest N entries posted when a feed is first seen. Empty = 0.",
        "Tyle najnowszych wpisów idzie przy pierwszym zobaczeniu feedu. Puste = 0.",
    ),
    (
        "One phrase per line; /regex/ allowed. Empty = everything.",
        "Jedna fraza na linię; można /regex/. Puste = wszystko.",
    ),
    (
        "One phrase per line; /regex/ allowed.",
        "Jedna fraza na linię; można /regex/.",
    ),
    (
        "Comma-separated, e.g. title, contentSnippet. Empty = title and summary.",
        "Po przecinku, np. title, contentSnippet. Puste = tytuł i opis.",
    ),
    (
        "Skip older entries. Empty = no limit.",
        "Pomijaj starsze wpisy. Puste = bez limitu.",
    ),
    (
        "Existing group, or a new one starting with “channels”.",
        "Istniejąca grupa albo nowa, zaczynająca się od „channels”.",
    ),
    (
        "Used only in named groups (JSON objects); array groups number channels automatically.",
        "Używane tylko w grupach z nazwami (obiekty JSON); w grupach-listach kanały są numerowane automatycznie.",
    ),
    (
        "Remaining channel keys (Telegram, Discord, Scrapling, ...) as a JSON object. Kept as is.",
        "Pozostałe klucze kanału (Telegram, Discord, Scrapling, ...) jako obiekt JSON. Zostają bez zmian.",
    ),
    (
        "Or ${ENV_NAME} to read it from .env.",
        "Albo ${ENV_NAME}, żeby wziąć wartość z .env.",
    ),
    ("to read it from .env.", ", żeby wziąć wartość z .env."),
    (
        "This config uses schema v2. Channels are listed read-only; edit them in",
        "Ten config używa schematu v2. Kanały są tylko do odczytu; edytuj je w zakładce",
    ),
    (
        "Schema v2: edit channels in Advanced.",
        "Schemat v2: edytuj kanały w zakładce Zaawansowane.",
    ),
    ("Channel saved.", "Kanał zapisany."),
    ("Channel deleted.", "Kanał usunięty."),
    (
        "Channel duplicated (added at the end of its group).",
        "Kanał zduplikowany (dodany na końcu swojej grupy).",
    ),
    (
        "Channel not found (the config may have changed).",
        "Nie znaleziono kanału (config mógł się zmienić).",
    ),
    ("Channel not found.", "Nie znaleziono kanału."),
    (
        "The channel no longer exists.",
        "Ten kanał już nie istnieje.",
    ),
    (
        "Add at least one source URL.",
        "Dodaj co najmniej jeden adres źródła.",
    ),
    (
        "Enter a name: this group stores channels by name.",
        "Wpisz nazwę: ta grupa przechowuje kanały według nazw.",
    ),
    (
        "New groups must be named “channels…” (for example channels2).",
        "Nowe grupy muszą się nazywać „channels…” (na przykład channels2).",
    ),
    (
        "Filters are set both in the form and in “Other settings”.",
        "Filtry są ustawione i w formularzu, i w „Inne ustawienia”.",
    ),
    (
        "“Other settings” must be a JSON object",
        "„Inne ustawienia” muszą być obiektem JSON",
    ),
    (
        "Not saved, configuration errors:",
        "Nie zapisano, błędy konfiguracji:",
    ),
    ("Warnings:", "Ostrzeżenia:"),
    (
        "Tick “Save despite warnings” to save anyway.",
        "Zaznacz „Zapisz mimo ostrzeżeń”, żeby zapisać mimo to.",
    ),
    ("Save despite warnings", "Zapisz mimo ostrzeżeń"),
    (
        "The configuration changed on disk since this page was opened. Reload and try again.",
        "Konfiguracja zmieniła się na dysku od otwarcia tej strony. Odśwież i spróbuj ponownie.",
    ),
    (
        "config.json is not valid JSON.",
        "config.json nie jest poprawnym JSON-em.",
    ),
    (
        "config.json is not valid JSON; fix it in Advanced.",
        "config.json nie jest poprawnym JSON-em; popraw go w zakładce Zaawansowane.",
    ),
    // Diagnostics
    ("Diagnostics recorder", "Rejestrator diagnostyki"),
    (
        "No diagnostics files yet.",
        "Nie ma jeszcze plików diagnostyki.",
    ),
    ("Recorder:", "Rejestrator:"),
    ("enabled", "włączony"),
    ("disabled", "wyłączony"),
    ("· folder", "· folder"),
    (
        ". Enable or tune it in",
        ". Włączysz go albo dostosujesz w zakładce",
    ),
    (
        "; the worker must be restarted to apply.",
        "; po zmianie trzeba zrestartować workera.",
    ),
    (
        "Records every event, timing and log line to",
        "Zapisuje każde zdarzenie, czas i linię logu do",
    ),
    (
        "and writes a latency report. Applied after a worker restart.",
        "i tworzy raport opóźnień. Działa po restarcie workera.",
    ),
    ("Files", "Pliki"),
    (
        "Newest 300 events first (one JSON object per line). The full file is on the server.",
        "Najpierw 300 najnowszych zdarzeń (jeden obiekt JSON na linię). Pełny plik jest na serwerze.",
    ),
    // Settings
    ("General", "Ogólne"),
    ("Network", "Sieć"),
    ("Secrets (.env)", "Sekrety (.env)"),
    (
        "Write log files (Logs)",
        "Zapisuj zwykłe informacje w logu (Logs)",
    ),
    (
        "Expert diagnostics on stdout (DebugExpert)",
        "Szczegółowa diagnostyka na stdout (DebugExpert)",
    ),
    (
        "Channels processed at once",
        "Kanały sprawdzane jednocześnie",
    ),
    (
        "First-run send (global)",
        "Wysyłka przy pierwszym sprawdzeniu (globalnie)",
    ),
    ("Keep files (days)", "Trzymaj pliki (dni)"),
    (
        "Max file size per day (MB)",
        "Maks. rozmiar pliku na dzień (MB)",
    ),
    ("Report every (minutes)", "Raport co (minuty)"),
    ("Enabled", "Włączone"),
    ("Bandwidth profile", "Profil łącza"),
    ("Download limit (Mbps)", "Limit pobierania (Mbps)"),
    ("Upload limit (Mbps)", "Limit wysyłania (Mbps)"),
    ("custom profile only", "tylko z profilem custom"),
    ("Network-friendly mode", "Tryb oszczędny dla sieci"),
    ("Max parallel requests", "Maks. równoległych zapytań"),
    (
        "Max parallel browser fetches",
        "Maks. równoległych pobrań przeglądarką",
    ),
    (
        "Browser resource saving",
        "Oszczędzanie zasobów przeglądarki",
    ),
    ("Connect timeout (ms)", "Limit czasu połączenia (ms)"),
    ("Idle timeout (ms)", "Limit ciszy (ms)"),
    ("Request deadline (ms)", "Limit całego zapytania (ms)"),
    ("Shutdown grace (ms)", "Czas na zamknięcie (ms)"),
    ("Outbound policy", "Polityka połączeń wychodzących"),
    (
        "public-only blocks private and local addresses.",
        "public-only blokuje adresy prywatne i lokalne.",
    ),
    (
        "Max response size (bytes)",
        "Maks. rozmiar odpowiedzi (bajty)",
    ),
    ("Save network settings", "Zapisz ustawienia sieci"),
    ("Settings saved.", "Ustawienia zapisane."),
    ("Network settings saved.", "Ustawienia sieci zapisane."),
    (
        "The current network section is invalid.",
        "Obecna sekcja network jest niepoprawna.",
    ),
    (
        "Channels processed at once must be 1–8.",
        "Liczba kanałów sprawdzanych jednocześnie musi być od 1 do 8.",
    ),
    (
        "Channels processed at once must be a number 1–8.",
        "Liczba kanałów sprawdzanych jednocześnie musi być liczbą od 1 do 8.",
    ),
    (
        "First-run send must be a whole number.",
        "Wysyłka przy pierwszym sprawdzeniu musi być liczbą całkowitą.",
    ),
    (
        "Values are never shown. Setting one replaces it in .env; the worker reads it on its next cycle.",
        "Wartości nigdy nie są pokazywane. Ustawienie zastępuje wartość w .env; worker wczyta ją w następnym obiegu.",
    ),
    ("Configured", "Ustawiony"),
    ("Missing", "Brak"),
    ("reserved", "zarezerwowany"),
    ("New value", "Nowa wartość"),
    ("Set", "Ustaw"),
    ("default", "domyślnie"),
    (
        "Invalid or reserved secret name.",
        "Niepoprawna albo zarezerwowana nazwa sekretu.",
    ),
    (
        "The secret must be referenced by the config or declared in .env.",
        "Sekret musi być użyty w configu albo zadeklarowany w .env.",
    ),
    (
        ".env changed since this page was opened. Try again.",
        ".env zmienił się od otwarcia tej strony. Spróbuj ponownie.",
    ),
    // Advanced
    (
        "This is the raw config.json. It may contain webhook URLs and tokens: do not share screenshots of this page.",
        "To surowy config.json. Może zawierać adresy webhooków i tokeny: nie udostępniaj zrzutów ekranu tej strony.",
    ),
    ("Validate and save", "Sprawdź i zapisz"),
    ("config.json saved.", "config.json zapisany."),
    (
        "Config root must be a JSON object.",
        "Główny element configu musi być obiektem JSON.",
    ),
    (
        "The root must be a JSON object.",
        "Główny element musi być obiektem JSON.",
    ),
    // Login
    (
        "Invalid dashboard password.",
        "Niepoprawne hasło do dashboardu.",
    ),
    (
        "Too many login attempts. Try again in a minute.",
        "Za dużo prób logowania. Spróbuj ponownie za minutę.",
    ),
    // Language switch
    ("Language", "Język"),
    // Overview upgrade
    (
        "The worker runs as a systemd service (or another process), so it is not controlled from here. Restart it with",
        "Worker działa jako usługa systemd (albo inny proces), więc nie jest sterowany stąd. Restart:",
    ),
    (
        "; configuration changes are picked up without a restart.",
        "; zmiany w konfiguracji działają bez restartu.",
    ),
    ("Since the worker started", "Od startu workera"),
    ("Feed checks", "Sprawdzenia feedów"),
    ("Failed checks", "Nieudane sprawdzenia"),
    ("Unchanged (HTTP 304)", "Bez zmian (HTTP 304)"),
    ("Entries read", "Odczytane wpisy"),
    ("Fetched through the browser", "Pobrane przez przeglądarkę"),
    ("Feed download", "Pobranie feedu"),
    ("Channel round", "Obieg kanału"),
    ("Sending a post", "Wysłanie posta"),
    ("Discord posts", "Posty na Discordzie"),
    ("Telegram posts", "Posty na Telegramie"),
    ("Recent posts", "Ostatnie posty"),
    ("Recent problems", "Ostatnie problemy"),
    ("Entry", "Wpis"),
    ("Feed", "Feed"),
    ("Important", "Ważne"),
    (
        "No posts recorded yet (posts are recorded since version 3.0 beta).",
        "Nie zapisano jeszcze postów (posty są zapisywane od wersji 3.0 beta).",
    ),
    (
        "The previous config is kept as config.json.bak.",
        "Poprzedni config zostaje jako config.json.bak.",
    ),
    (
        "This section is used; it can only be removed in Advanced.",
        "Ta sekcja jest używana; można ją usunąć tylko w zakładce Zaawansowane.",
    ),
    ("(+ SteamDB)", "(+ SteamDB)"),
];

static TABLE: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| EXACT.iter().copied().collect());

/// Polish plural: 1 → one, 2–4 (not 12–14) → few, otherwise many.
fn plural<'a>(n: u64, one: &'a str, few: &'a str, many: &'a str) -> &'a str {
    let (last, tens) = (n % 10, n % 100);
    if n == 1 {
        one
    } else if (2..=4).contains(&last) && !(12..=14).contains(&tens) {
        few
    } else {
        many
    }
}

type Rule = (Regex, fn(&regex::Captures) -> String);

fn word(value: &str) -> String {
    match value {
        "unlimited" => "bez limitu".into(),
        "none" => "brak".into(),
        other => lookup(other).unwrap_or(other).to_string(),
    }
}

fn count(text: &str) -> u64 {
    text.parse().unwrap_or(0)
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let rule = |pattern: &str, f: fn(&regex::Captures) -> String| -> Rule {
        (Regex::new(pattern).expect("i18n rule"), f)
    };
    vec![
        rule(r"^(.+) · XFeeder$", |c| {
            format!(
                "{} · XFeeder",
                translate_text(&c[1]).unwrap_or_else(|| c[1].to_string())
            )
        }),
        rule(r"^XFeeder v(\S+) · Rust · no JavaScript$", |c| {
            format!("XFeeder v{} · Rust · bez JavaScriptu", &c[1])
        }),
        rule(r"^(\d+) s ago$", |c| format!("{} s temu", &c[1])),
        rule(r"^(\d+) min ago$", |c| format!("{} min temu", &c[1])),
        rule(r"^(\d+) h ago$", |c| format!("{} h temu", &c[1])),
        rule(r"^(\d+) days ago$", |c| {
            let n = count(&c[1]);
            format!("{n} {} temu", plural(n, "dzień", "dni", "dni"))
        }),
        rule(r"^(\d+) feeds$", |c| {
            let n = count(&c[1]);
            format!("{n} {}", plural(n, "feed", "feedy", "feedów"))
        }),
        rule(r"^(\d+|–) sent$", |c| match c[1].parse::<u64>() {
            Ok(n) => format!("{n} {}", plural(n, "wysłany", "wysłane", "wysłanych")),
            Err(_) => "– wysłanych".into(),
        }),
        rule(r"^(\d+|–) errors$", |c| match c[1].parse::<u64>() {
            Ok(n) => format!("{n} {}", plural(n, "błąd", "błędy", "błędów")),
            Err(_) => "– błędów".into(),
        }),
        rule(r"^health: (\S+)$", |c| format!("stan: {}", word(&c[1]))),
        rule(r"^Worker: (.+)$", |c| {
            format!(
                "Worker: {}",
                translate_text(&c[1]).unwrap_or_else(|| c[1].to_string())
            )
        }),
        rule(
            r"^(\d+) channels\. Changes are picked up by the worker on its next cycle\.$",
            |c| {
                let n = count(&c[1]);
                format!(
                    "{n} {}. Worker wczyta zmiany w następnym obiegu.",
                    plural(n, "kanał", "kanały", "kanałów")
                )
            },
        ),
        rule(
            r"^with (\d+) source\(s\)\? Its delivery history stays in the cache\.$",
            |c| {
                let n = count(&c[1]);
                format!(
                    "z {n} {}? Jego historia wysyłek zostaje w cache.",
                    plural(n, "źródłem", "źródłami", "źródłami")
                )
            },
        ),
        rule(
            r"^Empty fields use the defaults\. HTTP concurrency (.+) · browser concurrency (.+) · request deadline (.+)$",
            |c| {
                format!(
                    "Puste pola = wartości domyślne. Zapytania HTTP naraz: {} · przeglądarka naraz: {} · limit zapytania: {}",
                    word(&c[1]),
                    word(&c[2]),
                    word(&c[3])
                )
            },
        ),
        rule(r"^Edit (.+)$", |c| format!("Edytuj {}", &c[1])),
        rule(r"^Worker (start|stop|restart): done\.$", |c| {
            let action = match &c[1] {
                "start" => "uruchomiony",
                "stop" => "zatrzymany",
                _ => "zrestartowany",
            };
            format!("Worker {action}.")
        }),
        rule(r"^Not an http\(s\) URL: (.*)$", |c| {
            format!("To nie jest adres http(s): {}", &c[1])
        }),
        rule(r"^(.+) must be a whole number\.$", |c| {
            format!("{} musi być liczbą całkowitą.", &c[1])
        }),
        rule(r"^(.+) must be a number\.$", |c| {
            format!("{} musi być liczbą.", &c[1])
        }),
        rule(
            r"^A channel named “(.+)” already exists in (.+)\.$",
            |c| format!("Kanał o nazwie „{}” już istnieje w {}.", &c[1], &c[2]),
        ),
        rule(
            r"^“(.+)” is another configuration field, not a channel group\.$",
            |c| format!("„{}” to inne pole konfiguracji, nie grupa kanałów.", &c[1]),
        ),
        rule(
            r"^“(.+)” is set both in the form and in “Other settings”\.$",
            |c| {
                format!(
                    "„{}” jest ustawione i w formularzu, i w „Inne ustawienia”.",
                    &c[1]
                )
            },
        ),
        rule(r"^“Other settings” is not valid JSON: (.*)$", |c| {
            format!("„Inne ustawienia” to niepoprawny JSON: {}", &c[1])
        }),
        rule(r"^Invalid JSON: (.*)$", |c| {
            format!("Niepoprawny JSON: {}", &c[1])
        }),
        rule(r"^Updated (.+)$", |c| {
            format!(
                "Zaktualizowano {}",
                translate_text(&c[1]).unwrap_or_else(|| c[1].to_string())
            )
        }),
        rule(r"^Remove the section “(.+)”$", |c| {
            format!("Usuń sekcję „{}”", &c[1])
        }),
        rule(
            r"^Section “(.+)” removed \(previous config in config\.json\.bak\)\.$",
            |c| {
                format!(
                    "Sekcja „{}” usunięta (poprzedni config w config.json.bak).",
                    &c[1]
                )
            },
        ),
        rule(r"^(.*), settings applied$", |c| {
            format!("{}, ustawienia zastosowane", &c[1])
        }),
        rule(r"^(.*), settings not applied yet$", |c| {
            format!("{}, ustawienia jeszcze niezastosowane", &c[1])
        }),
    ]
});

fn lookup(text: &str) -> Option<&'static str> {
    TABLE.get(text).copied()
}

/// Polish for one UI text, if known.
fn translate_text(text: &str) -> Option<String> {
    if let Some(pl) = lookup(text) {
        return Some(pl.to_string());
    }
    RULES
        .iter()
        .find_map(|(re, f)| re.captures(text).map(|c| f(&c)))
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Translate a text node or attribute value, keeping surrounding spaces.
fn node(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let pl = translate_text(&unescape(trimmed))?;
    let start = &raw[..raw.len() - raw.trim_start().len()];
    let end = &raw[raw.trim_end().len()..];
    Some(format!("{start}{}{end}", esc(&pl)))
}

static ATTRIBUTES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\b(placeholder|title|aria-label)="([^"]*)""#).unwrap());

fn tag(raw: &str) -> String {
    let raw = if raw.starts_with("<html") {
        raw.replace("lang=\"en\"", "lang=\"pl\"")
    } else {
        raw.to_string()
    };
    ATTRIBUTES
        .replace_all(&raw, |c: &regex::Captures| match node(&c[2]) {
            Some(pl) => format!("{}=\"{pl}\"", &c[1]),
            None => c[0].to_string(),
        })
        .into_owned()
}

/// Elements whose content is data, never UI text.
const VERBATIM: [&str; 5] = ["textarea", "pre", "code", "script", "style"];

fn tag_name(raw: &str) -> String {
    raw.trim_start_matches('<')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// The page in Polish.
pub(super) fn to_polish(html: &str) -> String {
    let mut out = String::with_capacity(html.len() + html.len() / 8);
    let mut rest = html;
    while !rest.is_empty() {
        let Some(open) = rest.find('<') else {
            out.push_str(&node(rest).unwrap_or_else(|| rest.to_string()));
            break;
        };
        let text = &rest[..open];
        out.push_str(&node(text).unwrap_or_else(|| text.to_string()));
        rest = &rest[open..];
        let close = rest.find('>').map_or(rest.len(), |i| i + 1);
        let raw = &rest[..close];
        out.push_str(&tag(raw));
        rest = &rest[close..];
        let name = tag_name(raw);
        if VERBATIM.contains(&name.as_str()) && !raw.ends_with("/>") {
            let end = format!("</{name}");
            let until = rest.to_ascii_lowercase().find(&end).unwrap_or(rest.len());
            out.push_str(&rest[..until]);
            rest = &rest[until..];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_ui_and_keeps_data() {
        let page = "<html lang=\"en\"><title>Edit main · XFeeder</title><nav><a href=\"/\">Overview</a></nav>\
            <p>Delete <strong>main</strong> with 3 source(s)? Its delivery history stays in the cache.</p>\
            <input placeholder=\"https://example.com/rss\" title=\"Webhook URL\">\
            <textarea>Save\nOverview</textarea><code>Settings</code>\
            <small>4 feeds</small><small>1 errors</small><small>22 sent</small><p>Tom &amp; Jerry</p>";
        let pl = to_polish(page);
        assert!(pl.starts_with("<html lang=\"pl\">"));
        assert!(pl.contains("<title>Edytuj main · XFeeder</title>"));
        assert!(pl.contains(">Przegląd</a>"));
        assert!(pl.contains(
            "<p>Usuń <strong>main</strong> z 3 źródłami? Jego historia wysyłek zostaje w cache.</p>"
        ));
        assert!(
            pl.contains("placeholder=\"https://example.com/rss\""),
            "URLs untouched"
        );
        assert!(pl.contains("title=\"Adres webhooka\""));
        assert!(
            pl.contains("<textarea>Save\nOverview</textarea>"),
            "config text untouched"
        );
        assert!(pl.contains("<code>Settings</code>"));
        assert!(pl.contains("4 feedy") && pl.contains("1 błąd") && pl.contains("22 wysłane"));
        assert!(
            pl.contains("<p>Tom &amp; Jerry</p>"),
            "unknown text kept as it was"
        );
        assert_eq!(plural(5, "a", "b", "c"), "c");
        assert_eq!(plural(13, "a", "b", "c"), "c");
        assert_eq!(plural(23, "a", "b", "c"), "b");
    }

    #[test]
    fn language_cookie_and_back_link() {
        let mut headers = HeaderMap::new();
        assert_eq!(from_headers(&headers), Lang::En);
        headers.insert(
            header::COOKIE,
            "xfeeder_session=abc; xf_lang=pl".parse().unwrap(),
        );
        assert_eq!(from_headers(&headers), Lang::Pl);
        assert_eq!(safe_back("/channels?x=1"), "/channels?x=1");
        assert_eq!(safe_back("//evil.example"), "/");
        assert_eq!(safe_back("https://evil.example"), "/");
    }

    #[test]
    fn every_entry_is_unique() {
        let mut keys: Vec<&str> = EXACT.iter().map(|(en, _)| *en).collect();
        let before = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), before, "duplicate English key in EXACT");
    }
}
