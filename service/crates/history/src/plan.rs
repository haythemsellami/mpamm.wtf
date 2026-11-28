//! What to repair: the venues' dated revisions, a new venue's lifetime and
//! an operator's replays, each named by a definition (`spec`) that is
//! applied once per database. A changed definition is a new one and runs
//! again.
//!
//! Specs are today's marker texts, so a database migrated from today's
//! service adopts what it already applied (`v1:history_revision_<venue>_<id>`
//! holds the very same text; `v1:backfill_done_<venue>` = 1 is a finished
//! lifetime; `v1:backfill_reset_applied_<venue>` an operator's entry):
//!
//! - a replay: `<venue>#<id>:<from|lifetime>`
//! - re-summed stored trades: `<venue>#<id>:fills:<from>..<until>`
//! - listed markets: `<venue>#<id>:markets:<from>:<markets, sorted, unique>`
//!
//! Two repairs of one venue must never count a trade twice. Replays replace
//! what they cover, so their order doesn't matter. Listed markets add, so a
//! markets repair stops where a replay pending beside it starts (that
//! replay decodes with this build, listed markets included), and one the
//! replay covers whole is marked applied with it. A venue's lifetime replay
//! stands for all its revisions: their changes are in the build that runs
//! it. Its job is named after the revisions it stands for, so a build that
//! brings a new one while it runs starts it over rather than leave the days
//! it wrote with the older build unrepaired.

use mpamm_core::{HistoryRevision, RevisionSource};

/// A venue's history repairs, as its module declares them.
#[derive(Debug, Clone)]
pub struct VenueHistory {
    pub id: String,
    pub revisions: Vec<HistoryRevision>,
    /// The first day of on-chain history (`None`: no lifetime replay).
    pub from_utc: Option<String>,
}

/// An operator's replay (today's `BACKFILL_RESET` grammar,
/// `venue[:from][@nonce]`), its start resolved to a day: a block start
/// replays its whole day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reset {
    pub entry: String,
    pub venue: String,
    /// `None`: the venue's lifetime.
    pub from: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// Decode the venue's days again and replace them.
    Replay,
    /// Add these markets' trades.
    Markets(Vec<String>),
    /// Re-sum stored trades over `from..until`.
    Fills { until: String },
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Replay => "replay",
            Kind::Markets(_) => "markets",
            Kind::Fills { .. } => "fills",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub venue: String,
    /// The job's identity (and its applied marker).
    pub spec: String,
    pub kind: Kind,
    /// First day written.
    pub from: String,
    /// First day not written (a markets repair stopping where a replay
    /// starts); `None`: through the job's last block.
    pub until: Option<String>,
    /// Definitions marked applied with this one.
    pub covers: Vec<String>,
    /// For notes: "revision november-xstocks", "lifetime", "operator replay …".
    pub what: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub jobs: Vec<Planned>,
    /// Definitions today's service already applied: (venue, spec).
    pub adopt: Vec<(String, String)>,
    /// Marked applied without running: (venue, spec, why).
    pub refused: Vec<(String, String, String)>,
    /// Definitions that can't be applied yet (notes; asked again later).
    pub waiting: Vec<String>,
    /// Malformed definitions (notes on every boot).
    pub invalid: Vec<String>,
}

/// Where an operator's replay starts, as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Start {
    Day(String),
    /// Resolved to its day before planning.
    Block(u64),
}

/// One parsed operator entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetEntry {
    pub entry: String,
    pub venue: String,
    /// `None`: the venue's lifetime.
    pub from: Option<Start>,
}

/// Parses today's `BACKFILL_RESET` grammar: comma-separated
/// `venue[:from][@nonce]`, `from` a UTC day or a block number. Returns the
/// entries and what couldn't be read.
pub fn parse_resets(value: &str) -> (Vec<ResetEntry>, Vec<String>) {
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let body = entry.split('@').next().unwrap_or("");
        let (venue, from) = match body.split_once(':') {
            Some((v, f)) => (v, Some(f)),
            None => (body, None),
        };
        if venue.is_empty() || !venue.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            bad.push(format!("operator replay {entry:?}: no venue"));
            continue;
        }
        let from = match from {
            None => None,
            Some(f) if is_day(f) => Some(Start::Day(f.to_string())),
            Some(f) => match f.parse::<u64>() {
                Ok(b) => Some(Start::Block(b)),
                Err(_) => {
                    bad.push(format!("operator replay {entry:?}: {f:?} is neither a day nor a block"));
                    continue;
                }
            },
        };
        ok.push(ResetEntry { entry: entry.to_string(), venue: venue.to_string(), from });
    }
    (ok, bad)
}

/// `YYYY-MM-DD`.
pub fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// A revision's spec, in today's marker format.
pub fn revision_spec(venue: &str, r: &HistoryRevision) -> Result<String, String> {
    Ok(match (r.source, r.from) {
        (RevisionSource::Replay, from) => format!("{venue}#{}:{}", r.id, from.unwrap_or("lifetime")),
        (RevisionSource::Fills { until }, Some(from)) => format!("{venue}#{}:fills:{from}..{until}", r.id),
        (RevisionSource::Markets(markets), Some(from)) => {
            let mut m: Vec<&str> = markets.to_vec();
            m.sort_unstable();
            m.dedup();
            format!("{venue}#{}:markets:{from}:{}", r.id, m.join(","))
        }
        (_, None) => return Err(format!("{venue} revision {}: a fills or markets revision needs a from day", r.id)),
    })
}

/// A venue's finished lifetime replay.
pub fn lifetime_spec(venue: &str, from: &str) -> String {
    format!("{venue}#lifetime:{from}")
}

/// FNV-1a: a stable short name for the revisions a lifetime job stands for.
fn short_hash(parts: &[String]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in parts.join("\n").bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:08x}", h >> 32)
}

/// Plans the repairs. `applied(venue, spec)` reads the store's markers,
/// `v1(key)` today's (migrated) meta.
pub fn plan(
    venues: &[VenueHistory],
    resets: &[Reset],
    today: &str,
    trades_from: &str,
    applied: impl Fn(&str, &str) -> bool,
    v1: impl Fn(&str) -> Option<String>,
) -> Plan {
    let mut p = Plan::default();
    for v in venues {
        let vid = v.id.as_str();
        // Ids must be well formed and unique: every entry sharing an id is
        // invalid, the first included (today's rule).
        let mut specs: Vec<(HistoryRevision, String)> = Vec::new();
        for r in &v.revisions {
            if !id_ok(r.id) {
                p.invalid.push(format!("{vid} revision {:?}: an id is letters, digits, _ . -", r.id));
                continue;
            }
            if v.revisions.iter().filter(|o| o.id == r.id).count() > 1 {
                p.invalid.push(format!("{vid} revision {}: the id is used more than once", r.id));
                continue;
            }
            match revision_spec(vid, r) {
                Ok(s) => specs.push((r.clone(), s)),
                Err(e) => p.invalid.push(e),
            }
        }
        // The lifetime first: when it runs it stands for every revision.
        let mut venue_jobs: Vec<Planned> = Vec::new();
        let mut lifetime = false;
        if let Some(from) = &v.from_utc {
            let base = lifetime_spec(vid, from);
            let done = applied(vid, &base);
            if !done && v1(&format!("backfill_done_{vid}")).as_deref() == Some("1") {
                p.adopt.push((vid.to_string(), base));
            } else if !done {
                let mut covers: Vec<String> = specs.iter().map(|(_, s)| s.clone()).collect();
                let spec = format!("{base}@{}", short_hash(&covers));
                covers.push(base);
                venue_jobs.push(Planned {
                    venue: vid.to_string(),
                    spec,
                    kind: Kind::Replay,
                    from: from.clone(),
                    until: None,
                    covers,
                    what: "lifetime".into(),
                });
                lifetime = true;
            }
        }

        for (r, spec) in &specs {
            let legacy = format!("history_revision_{vid}_{}", r.id);
            if applied(vid, spec) {
                continue;
            }
            if v1(&legacy).as_deref() == Some(spec.as_str()) {
                p.adopt.push((vid.to_string(), spec.clone()));
                continue;
            }
            if lifetime {
                continue;
            }
            let what = format!("revision {}", r.id);
            match r.source {
                RevisionSource::Replay => {
                    let Some(from) = r.from.map(str::to_string).or_else(|| v.from_utc.clone()) else {
                        p.invalid.push(format!("{vid} {what}: a lifetime replay needs the venue's first day"));
                        continue;
                    };
                    if from.as_str() > today {
                        p.refused.push((vid.to_string(), spec.clone(), format!("{what} starts after today")));
                        continue;
                    }
                    venue_jobs.push(Planned {
                        venue: vid.to_string(),
                        spec: spec.clone(),
                        kind: Kind::Replay,
                        from,
                        until: None,
                        covers: vec![],
                        what,
                    });
                }
                RevisionSource::Markets(markets) => {
                    let from = r.from.expect("checked by revision_spec").to_string();
                    if from.as_str() > today {
                        p.refused.push((vid.to_string(), spec.clone(), format!("{what} starts after today")));
                        continue;
                    }
                    let mut m: Vec<String> = markets.iter().map(|s| s.to_string()).collect();
                    m.sort_unstable();
                    m.dedup();
                    venue_jobs.push(Planned {
                        venue: vid.to_string(),
                        spec: spec.clone(),
                        kind: Kind::Markets(m),
                        from,
                        until: None,
                        covers: vec![],
                        what,
                    });
                }
                RevisionSource::Fills { until } => {
                    let from = r.from.expect("checked by revision_spec").to_string();
                    if from.as_str() < trades_from {
                        p.refused.push((
                            vid.to_string(),
                            spec.clone(),
                            format!("{what}: its days ({from}..{until}) are older than the stored trades ({trades_from} on)"),
                        ));
                        continue;
                    }
                    if until > today {
                        p.waiting.push(format!("{vid} {what}: waits for {until} to close"));
                        continue;
                    }
                    venue_jobs.push(Planned {
                        venue: vid.to_string(),
                        spec: spec.clone(),
                        kind: Kind::Fills { until: until.to_string() },
                        from,
                        until: None,
                        covers: vec![],
                        what,
                    });
                }
            }
        }

        for r in resets.iter().filter(|r| r.venue == vid) {
            let legacy = format!("backfill_reset_applied_{vid}");
            if applied(vid, &r.entry) {
                continue;
            }
            if v1(&legacy).as_deref() == Some(r.entry.as_str()) {
                p.adopt.push((vid.to_string(), r.entry.clone()));
                continue;
            }
            let Some(from) = r.from.clone().or_else(|| v.from_utc.clone()) else {
                p.invalid.push(format!("operator replay {:?}: {vid} has no first day for a lifetime replay", r.entry));
                continue;
            };
            if from.as_str() > today {
                p.refused.push((
                    vid.to_string(),
                    r.entry.clone(),
                    format!("operator replay {:?} starts after today", r.entry),
                ));
                continue;
            }
            venue_jobs.push(Planned {
                venue: vid.to_string(),
                spec: r.entry.clone(),
                kind: Kind::Replay,
                from,
                until: None,
                covers: vec![],
                what: format!("operator replay {}", r.entry),
            });
        }

        // A markets repair stops where the earliest pending replay starts,
        // and one that replay covers whole goes with it.
        let replay_from = venue_jobs.iter().filter(|j| j.kind == Kind::Replay).map(|j| j.from.clone()).min();
        if let Some(rf) = replay_from {
            let mut covered: Vec<String> = Vec::new();
            venue_jobs.retain_mut(|j| {
                if !matches!(j.kind, Kind::Markets(_)) {
                    return true;
                }
                if j.from >= rf {
                    covered.push(j.spec.clone());
                    false
                } else {
                    j.until = Some(rf.clone());
                    true
                }
            });
            if let Some(first) =
                venue_jobs.iter_mut().filter(|j| j.kind == Kind::Replay).min_by(|a, b| a.from.cmp(&b.from))
            {
                first.covers.extend(covered);
            }
        }
        p.jobs.extend(venue_jobs);
    }
    for r in resets {
        if !venues.iter().any(|v| v.id == r.venue) {
            p.invalid.push(format!("operator replay {:?}: no venue {}", r.entry, r.venue));
        }
    }
    p
}

#[cfg(test)]
mod tests;
