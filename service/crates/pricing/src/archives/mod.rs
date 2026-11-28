//! The exchanges' historical archives (docs/rebuild-plan.md → M7), ported
//! from server/src/history/cex.ts: what prices a trade the live history can't
//! (its markouts when it was decoded after the fact, a closed day replayed by
//! a history scan).
//!
//! Both exchanges publish what the live reference reads, keylessly:
//!  - Bybit: daily order-book archives replayed to a BBO-mid curve, the base
//!    series for MON and the stable crosses of Bybit-based pairs (USDCUSDT,
//!    USD1USDT). Published the next day.
//!  - Binance: 1-second klines through the data mirror (BTC, ETH, XAUt), and
//!    1-minute klines for the slow cross and wrap legs. Served as they close.
//!
//! Every series is a carry-forward step series with a staleness cap
//! (`series`), so a gap yields no price, never a carried one. The pair's mid
//! is built from these series by the live reference's own pair-terms code
//! (`Reference::mid_for_pair` over `Exchanges` read at the archive's time),
//! so the archives and the live books can never disagree on construction.
//!
//! Answers distinguish what will never come (`Unsupported`: Kraken's xStock
//! books have no keyless archive) from what isn't here yet (`Pending`: a
//! Bybit day not published), and both from a failure (`Err`, retried later).
//! Days are cached on disk under the configured directory (`cache`).

pub mod binance;
pub mod bybit;
pub mod cache;
pub mod closed_day;
pub mod series;

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use mpamm_registry::{Cex, Pair, Registry};
use mpamm_types::utc_day;

pub use binance::Interval;
pub use closed_day::{ClosedDayPricer, ClosedDayPrices, DayLoader};
pub use series::{DayPrices, Points, StepSeries, KLINE_JOIN_MS, STALE_BASE_MS, STALE_SLOW_MS};

use crate::reference::{Exchanges, Rates, Reference};

pub const DAY_MS: i64 = 86_400_000;

/// How long after a day closes its Bybit archive may still be on its way. The
/// file is published the next day, usually within minutes of midnight and at
/// times hours later; one still missing after this is not coming.
pub const PUBLISH_GRACE_MS: f64 = 3.0 * 86_400_000.0;

/// A Binance day is final (every kline in it closed, so it can be cached)
/// this long after it ends.
const BINANCE_FINAL_MS: i64 = 2 * 60_000;

#[derive(Debug, Clone, PartialEq)]
pub enum ArchiveError {
    /// The archive should answer and hasn't yet (a Bybit day not published).
    NotPublished {
        symbol: String,
        day: String,
    },
    /// A download failed after its retries.
    Http(String),
    /// A download or cached file that can't be trusted.
    Corrupt(String),
    Io(String),
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArchiveError::NotPublished { symbol, day } => {
                write!(f, "bybit book archive {symbol} {day} is not published yet")
            }
            ArchiveError::Http(m) | ArchiveError::Corrupt(m) | ArchiveError::Io(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for ArchiveError {}

/// An archive's answer for a window.
#[derive(Debug)]
pub enum Answer<T> {
    Ready(T),
    /// The archive covering part of the window isn't published yet: ask again
    /// later (`PUBLISH_GRACE_MS` says when to stop).
    Pending(String),
    /// No archive will ever answer (Kraken's xStock books, an unregistered
    /// market).
    Unsupported,
}

#[derive(Debug, Clone)]
pub struct ArchiveConfig {
    /// Where reduced days are cached.
    pub cache_dir: PathBuf,
    pub bybit_url: String,
    pub binance_url: String,
    /// Between two kline pages of one range.
    pub pace: Duration,
    /// Kline pages in flight when a whole day is fetched (a day of 1-second
    /// klines is 87 pages; the data mirror allows ~3,000 a minute).
    pub lanes: usize,
    /// Tries per request (a 404 is an answer, never retried).
    pub attempts: u32,
    /// Between tries: this, times the try number.
    pub backoff: Duration,
}

impl ArchiveConfig {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            cache_dir: cache_dir.into(),
            bybit_url: bybit::DEFAULT_URL.into(),
            binance_url: binance::DEFAULT_URL.into(),
            pace: Duration::from_millis(40),
            lanes: 16,
            attempts: 5,
            backoff: Duration::from_millis(500),
        }
    }
}

/// HTTP with retries. Errors name the source (symbol, day), never a URL.
pub struct Http {
    client: reqwest::Client,
    attempts: u32,
    backoff: Duration,
}

/// What a GET found.
enum Got {
    Body(Vec<u8>),
    NotFound,
}

/// A kline page or a probe: a stalled answer is retried, not waited on.
const SHORT: Duration = Duration::from_secs(15);
/// A day's book archive (several MB).
const LONG: Duration = Duration::from_secs(600);

impl Http {
    fn new(attempts: u32, backoff: Duration) -> Self {
        let client = reqwest::Client::builder().connect_timeout(SHORT).build().expect("http client");
        Self { client, attempts: attempts.max(1), backoff }
    }

    /// A GET, retried. Asks for gzip and inflates it here: a day of 1-second
    /// klines is ~14 MB of JSON, ~3 MB gzipped (the workspace's HTTP client
    /// decompresses nothing, and the RPC paths that share it shouldn't).
    async fn get(&self, url: &str, what: &str, timeout: Duration) -> Result<Got, ArchiveError> {
        use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING};
        let mut last = String::new();
        for i in 0..self.attempts {
            if i > 0 {
                tokio::time::sleep(self.backoff * i).await;
            }
            match self.client.get(url).header(ACCEPT_ENCODING, "gzip").timeout(timeout).send().await {
                Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => return Ok(Got::NotFound),
                Ok(r) if r.status().is_success() => {
                    let gzip =
                        r.headers().get(CONTENT_ENCODING).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"gzip"));
                    match r.bytes().await {
                        Ok(b) if !gzip => return Ok(Got::Body(b.to_vec())),
                        Ok(b) => {
                            let mut out = Vec::with_capacity(b.len() * 5);
                            match std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&b[..]), &mut out) {
                                Ok(_) => return Ok(Got::Body(out)),
                                Err(e) => last = format!("gzip body: {e}"),
                            }
                        }
                        Err(e) => last = format!("body: {}", e.without_url()),
                    }
                }
                Ok(r) => last = format!("status {}", r.status().as_u16()),
                Err(e) => last = e.without_url().to_string(),
            }
        }
        Err(ArchiveError::Http(format!("{what}: {last}")))
    }

    async fn get_text(&self, url: &str, what: &str) -> Result<String, ArchiveError> {
        match self.get(url, what, SHORT).await? {
            Got::Body(b) => String::from_utf8(b).map_err(|_| ArchiveError::Corrupt(format!("{what}: not text"))),
            Got::NotFound => Err(ArchiveError::Http(format!("{what}: status 404"))),
        }
    }

    /// Whether `url` exists (HEAD, no body). Anything but a 404 counts as
    /// yes: the GET decides, and a flaky probe must not invent an
    /// "unpublished" verdict.
    async fn exists(&self, url: &str) -> bool {
        match self.client.head(url).timeout(SHORT).send().await {
            Ok(r) => r.status() != reqwest::StatusCode::NOT_FOUND,
            Err(_) => true,
        }
    }
}

/// The role a symbol plays in a pair, which decides its source and cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The base, or an asset quote: book mids or 1-second klines, 2-minute cap.
    Base,
    /// A stable cross or wrapper basis: book mids or 1-minute klines,
    /// 30-minute cap.
    Slow,
}

impl Role {
    pub fn stale_ms(self) -> f64 {
        match self {
            Role::Base => STALE_BASE_MS,
            Role::Slow => STALE_SLOW_MS,
        }
    }
}

/// One series a pair's reference reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leg {
    pub cex: Cex,
    pub symbol: String,
    pub role: Role,
}

/// Whether a pair can be marked from the archives: Kraken's xStock books
/// have no keyless archive, and minute candles or the underlying equity can't
/// reconstruct those token-book marks.
pub fn supports(registry: &Registry, market: &str) -> bool {
    legs(registry, market).is_some()
}

/// The series a pair's reference reads, each in the role that sets its
/// source and cap; `None` when no archive answers for the pair. The same legs
/// `Reference` reads from the live books.
pub fn legs(registry: &Registry, market: &str) -> Option<Vec<Leg>> {
    let pair = registry.pair_of(market)?;
    let base = registry.asset_of(&pair.base)?;
    if base.cex == Cex::Kraken {
        return None;
    }
    let mut out = Vec::new();
    let mut add = |cex: Cex, symbol: &str, role: Role| {
        if !out.iter().any(|l: &Leg| l.cex == cex && l.symbol == symbol) {
            out.push(Leg { cex, symbol: symbol.to_string(), role });
        }
    };
    add(base.cex, &base.cex_symbol, Role::Base);
    if let Some(w) = registry.wrap_basis_for(pair) {
        add(Cex::Binance, w, Role::Slow);
    }
    if let Some(w) = &pair.quote_wrap_basis_symbol {
        add(Cex::Binance, w, Role::Slow);
    }
    if pair.is_asset_quoted() {
        let q = registry.asset_of(&pair.quote)?;
        if q.cex == Cex::Kraken {
            return None;
        }
        add(q.cex, &q.cex_symbol, Role::Base);
    } else if let Some(cross) = registry.tokens.get(&pair.quote).and_then(|t| t.usdt_cross.as_deref()) {
        add(if base.cex == Cex::Binance { Cex::Binance } else { Cex::Bybit }, cross, Role::Slow);
    }
    Some(out)
}

/// The exchanges as the archives had them at `t`.
struct ArchiveAt<'a> {
    legs: &'a [(Leg, StepSeries)],
    t: f64,
}

impl Exchanges for ArchiveAt<'_> {
    fn mid(&self, cex: Cex, symbol: &str) -> f64 {
        self.legs
            .iter()
            .find(|(l, _)| l.cex == cex && l.symbol == symbol)
            .and_then(|(_, s)| s.at(self.t))
            .unwrap_or(0.0)
    }
}

/// No wrapped xStock has an archive (their books are Kraken's): a wrapper's
/// rate is unavailable, any other token's is 1.
struct NoWrapperRates<'a>(&'a Registry);

impl Rates for NoWrapperRates<'_> {
    fn rate(&self, token_key: &str) -> f64 {
        match self.0.tokens.get(token_key) {
            Some(t) if t.underlying_x_stock.is_some() => 0.0,
            _ => 1.0,
        }
    }
}

/// A pair's reference mid over a window, from the archives.
pub struct PairMids {
    registry: &'static Registry,
    market: String,
    pair: &'static Pair,
    legs: Vec<(Leg, StepSeries)>,
}

impl std::fmt::Debug for PairMids {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let legs: Vec<String> = self.legs.iter().map(|(l, s)| format!("{}:{}", l.symbol, s.points.len())).collect();
        write!(f, "PairMids({} {legs:?})", self.market)
    }
}

impl PairMids {
    /// The pair's mid in its own terms at `t` (the markout mark): `None` when
    /// any leg has no price then. Unlike the live books' cold start, a
    /// missing wrapper basis is no price, never parity.
    pub fn at(&self, t: f64) -> Option<f64> {
        let ex = ArchiveAt { legs: &self.legs, t };
        if let Some(w) = self.registry.wrap_basis_for(self.pair) {
            if ex.mid(Cex::Binance, w) <= 0.0 {
                return None;
            }
        }
        let m = Reference { registry: self.registry, ex: &ex, rates: &NoWrapperRates(self.registry) }
            .mid_for_pair(&self.market);
        (m > 0.0).then_some(m)
    }

    pub fn legs(&self) -> impl Iterator<Item = (&Leg, &StepSeries)> {
        self.legs.iter().map(|(l, s)| (l, s))
    }
}

fn day_start(day: &str) -> Option<i64> {
    let (y, rest) = day.split_once('-')?;
    let (m, d) = rest.split_once('-')?;
    let (y, m, d): (i64, i64, i64) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    // Days-from-civil (Howard Hinnant), proleptic Gregorian.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = days * DAY_MS;
    (utc_day(ms as f64) == day).then_some(ms)
}

/// The UTC days (`YYYY-MM-DD`, chronological) that [from, to) touches.
fn days_of(from: f64, to: f64) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    let mut t = (from / DAY_MS as f64).floor() as i64 * DAY_MS;
    while (t as f64) < to {
        out.push((utc_day(t as f64), t));
        t += DAY_MS;
    }
    out
}

/// The archives, with their cache.
pub struct Archives {
    pub registry: &'static Registry,
    cfg: ArchiveConfig,
    http: Http,
    memo: cache::Memo,
    /// One download at a time: two sweeps asking for the same day share it.
    fetching: tokio::sync::Mutex<()>,
}

impl Archives {
    pub fn new(registry: &'static Registry, cfg: ArchiveConfig) -> Arc<Self> {
        Arc::new(Self {
            registry,
            http: Http::new(cfg.attempts, cfg.backoff),
            cfg,
            memo: cache::Memo::new(16),
            fetching: tokio::sync::Mutex::new(()),
        })
    }

    pub fn cache_dir(&self) -> &std::path::Path {
        &self.cfg.cache_dir
    }

    /// One Bybit day's BBO-mid curve: from memory, the disk cache, or
    /// downloaded, replayed and cached. `None` = not published.
    pub async fn bybit_day(&self, symbol: &str, day: &str) -> Result<Option<Arc<Points>>, ArchiveError> {
        let path = cache::bybit_path(&self.cfg.cache_dir, symbol, day);
        if let Some(p) = self.memo.get(&path) {
            return Ok(Some(p));
        }
        let _one = self.fetching.lock().await;
        if let Some(p) = self.memo.get(&path) {
            return Ok(Some(p));
        }
        if let Some(p) = cache::read(&path)? {
            return Ok(Some(self.memo.put(path, Arc::new(p))));
        }
        let Some(start) = day_start(day) else { return Err(ArchiveError::Corrupt(format!("bad day {day}"))) };
        let what = format!("bybit book archive {symbol} {day}");
        let t0 = Instant::now();
        let zip = match self.http.get(&bybit::url(&self.cfg.bybit_url, symbol, day), &what, LONG).await? {
            Got::NotFound => return Ok(None),
            Got::Body(b) => b,
        };
        let (sym, d) = (symbol.to_string(), day.to_string());
        let zip_len = zip.len();
        let pts = tokio::task::spawn_blocking(move || bybit::replay_zip(&zip, &sym, &d, start))
            .await
            .map_err(|e| ArchiveError::Io(format!("{what}: replay task: {e}")))??;
        cache::write(&path, &pts)?;
        tracing::info!(
            "archives: {what} replayed to {} mids ({:.1} MB zipped) in {:.1}s",
            pts.len(),
            zip_len as f64 / 1e6,
            t0.elapsed().as_secs_f64()
        );
        Ok(Some(self.memo.put(path, Arc::new(pts))))
    }

    /// Whether a Bybit day is published (cached, or the archive answers a
    /// HEAD): lets a request for several days defer before downloading any.
    async fn bybit_published(&self, symbol: &str, day: &str) -> bool {
        let path = cache::bybit_path(&self.cfg.cache_dir, symbol, day);
        if self.memo.get(&path).is_some() || path.exists() {
            return true;
        }
        self.http.exists(&bybit::url(&self.cfg.bybit_url, symbol, day)).await
    }

    /// One Binance day of kline closes. A final day comes from the cache or
    /// is fetched whole and cached; the current day is fetched up to now and
    /// kept nowhere (its klines are still arriving).
    pub async fn binance_day(
        &self,
        symbol: &str,
        interval: Interval,
        day: &str,
        now_ms: i64,
    ) -> Result<Arc<Points>, ArchiveError> {
        self.binance_part(symbol, interval, day, (i64::MIN, i64::MAX), now_ms).await
    }

    /// Like `binance_day`, but a day still in progress is fetched only for
    /// the klines opened within `open` (inclusive): marking a few trades of
    /// today needs a page, not the day's 87.
    async fn binance_part(
        &self,
        symbol: &str,
        interval: Interval,
        day: &str,
        open: (i64, i64),
        now_ms: i64,
    ) -> Result<Arc<Points>, ArchiveError> {
        let Some(start) = day_start(day) else { return Err(ArchiveError::Corrupt(format!("bad day {day}"))) };
        let end = start + DAY_MS;
        if end + BINANCE_FINAL_MS > now_ms {
            let r = binance::Range { symbol, interval, from: open.0.max(start), to: open.1.min(end - 1) };
            let p = binance::closes(&self.http, &self.cfg.binance_url, r, now_ms, self.cfg.pace).await?;
            return Ok(Arc::new(p));
        }
        let path = cache::binance_path(&self.cfg.cache_dir, symbol, interval, day);
        if let Some(p) = self.memo.get(&path) {
            return Ok(p);
        }
        let _one = self.fetching.lock().await;
        if let Some(p) = self.memo.get(&path) {
            return Ok(p);
        }
        if let Some(p) = cache::read(&path)? {
            return Ok(self.memo.put(path, Arc::new(p)));
        }
        let t0 = Instant::now();
        let r = binance::Range { symbol, interval, from: start, to: end - 1 };
        let p =
            binance::closes_sliced(&self.http, &self.cfg.binance_url, r, now_ms, self.cfg.pace, self.cfg.lanes).await?;
        cache::write(&path, &p)?;
        tracing::info!(
            "archives: binance {symbol} {} {day}: {} closes in {:.1}s",
            interval.as_str(),
            p.len(),
            t0.elapsed().as_secs_f64()
        );
        Ok(self.memo.put(path, Arc::new(p)))
    }

    /// A leg's series over [from, to): every day it touches, stitched in
    /// order. `Pending` when a Bybit day isn't published yet (checked for
    /// every day before any download).
    pub async fn leg_series(
        &self,
        leg: &Leg,
        from: f64,
        to: f64,
        now_ms: i64,
    ) -> Result<Answer<StepSeries>, ArchiveError> {
        let lead = leg.role.stale_ms();
        let days = days_of(from - lead, to);
        if leg.cex == Cex::Bybit {
            for (day, _) in &days {
                if !self.bybit_published(&leg.symbol, day).await {
                    return Ok(Answer::Pending(format!(
                        "bybit book archive {} {day} is not published yet",
                        leg.symbol
                    )));
                }
            }
        }
        let mut pts = Points::default();
        for (day, _) in &days {
            let p = match leg.cex {
                Cex::Bybit => match self.bybit_day(&leg.symbol, day).await? {
                    Some(p) => p,
                    None => {
                        return Ok(Answer::Pending(format!(
                            "bybit book archive {} {day} is not published yet",
                            leg.symbol
                        )))
                    }
                },
                Cex::Binance => {
                    let interval = if leg.role == Role::Base { Interval::S1 } else { Interval::M1 };
                    // Klines whose close can fall in the window.
                    let open = ((from - lead).floor() as i64 - interval.ms(), to.ceil() as i64);
                    self.binance_part(&leg.symbol, interval, day, open, now_ms).await?
                }
                Cex::Kraken => return Ok(Answer::Unsupported),
            };
            pts.extend_within(&p, from - lead, to);
        }
        Ok(Answer::Ready(StepSeries::new(pts, leg.role.stale_ms())))
    }

    /// The pair's reference mid over [from, to) (epoch ms), from the
    /// archives, in the pair's own terms.
    pub async fn pair_mids(
        &self,
        market: &str,
        from: f64,
        to: f64,
        now_ms: i64,
    ) -> Result<Answer<PairMids>, ArchiveError> {
        let Some(pair) = self.registry.pair_of(market) else { return Ok(Answer::Unsupported) };
        let Some(legs) = legs(self.registry, market) else { return Ok(Answer::Unsupported) };
        let mut loaded = Vec::with_capacity(legs.len());
        for leg in legs {
            match self.leg_series(&leg, from, to, now_ms).await? {
                Answer::Ready(s) => loaded.push((leg, s)),
                Answer::Pending(why) => return Ok(Answer::Pending(why)),
                Answer::Unsupported => return Ok(Answer::Unsupported),
            }
        }
        Ok(Answer::Ready(PairMids { registry: self.registry, market: market.to_string(), pair, legs: loaded }))
    }

    /// One asset's USD price across one closed UTC day (`assetUsdDay`): the
    /// asset's own book in USDT terms, USDT taken as $1. Bybit: the day's
    /// BBO-mid curve (the file the markouts already use); Binance: 1-minute
    /// closes joined by straight lines (seconds matter, but 1-second klines
    /// are 87 requests per asset-day).
    ///
    /// `Ok(None)`: no archive will answer (a Kraken xStock, an asset its
    /// exchange didn't list yet, a Bybit day still unpublished long after it
    /// closed): the caller keeps the live price and says so.
    /// `Err`: the archive should answer and hasn't (a Bybit day not published,
    /// a failed download): the caller holds and retries; it must not fall
    /// back, or a closed day would be priced from today on a bad connection.
    pub async fn asset_usd_day(&self, asset: &str, day: &str, now_ms: i64) -> Result<Option<DayPrices>, ArchiveError> {
        let Some(a) = self.registry.asset_of(asset) else { return Ok(None) };
        let Some(start) = day_start(day) else { return Ok(None) };
        let end = start + DAY_MS;
        match a.cex {
            Cex::Kraken => Ok(None),
            // Klines are served as they close, so an empty closed day is a
            // day the symbol didn't trade, not one still to come.
            Cex::Binance => {
                Ok(DayPrices::new(&*self.binance_day(&a.cex_symbol, Interval::M1, day, now_ms).await?, true))
            }
            Cex::Bybit => match self.bybit_day(&a.cex_symbol, day).await? {
                Some(p) => Ok(DayPrices::new(&p, false)),
                None if (now_ms - end) as f64 > PUBLISH_GRACE_MS => Ok(None),
                None => Err(ArchiveError::NotPublished { symbol: a.cex_symbol.clone(), day: day.to_string() }),
            },
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
