//! USD prices for decoding a closed day, from the exchanges' archives,
//! ported from server/src/closed-day-prices.ts.
//!
//! A trade on a crypto-quoted pair (cbBTC/MON, MON/ETH …) has no stable leg,
//! so its USD is the quote amount × that asset's USD price, which decode
//! takes from its pricer. A history replay decodes days, weeks or months after
//! the trade, when the live price is the price on the day of the replay: BTR's
//! lifetime backfill (2026-11-16) booked its October crypto-quoted trades
//! 24.5% low that way. A replay runs in the background on closed days and can
//! wait on an archive, so it asks the archives the markouts use, which answer
//! at any depth.
//!
//! Prices are loaded per asset and UTC day, and only for assets a decode
//! actually asks about: a venue with no crypto-quoted market never fetches
//! anything. The pricer is synchronous, so the first decode of a block that
//! needs an unloaded asset-day only finds out what to load: it is thrown
//! away, the day is loaded, and the block is decoded again (decode is pure,
//! so it is safe to run twice).

use std::{collections::VecDeque, sync::Arc};

use async_trait::async_trait;
use mpamm_core::Pricer;
use mpamm_registry::Registry;
use mpamm_types::utc_day;
use parking_lot::Mutex;

use super::{ArchiveError, Archives, DayPrices};

/// Asset-days kept parsed: a replay walks forward a day at a time over a
/// handful of assets.
const DAYS_KEPT: usize = 12;
/// More passes than there are priced assets means a load left a day unloaded.
const MAX_PASSES: usize = 8;

/// Where asset-days come from: the archives, or a stand-in in tests.
#[async_trait]
pub trait DayLoader: Send + Sync {
    /// See `Archives::asset_usd_day`.
    async fn load(&self, asset: &str, day: &str) -> Result<Option<DayPrices>, ArchiveError>;
}

#[async_trait]
impl DayLoader for Archives {
    async fn load(&self, asset: &str, day: &str) -> Result<Option<DayPrices>, ArchiveError> {
        let now = crate::feeds::now_ms() as i64;
        self.asset_usd_day(asset, day, now).await
    }
}

/// What the archives say about an asset at a time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Peek {
    Price(f64),
    /// No archive answers for that asset-day: the live price stands.
    NoArchive,
    /// The day isn't loaded yet.
    Unloaded,
}

type Day = (String, String);

pub struct ClosedDayPrices {
    registry: &'static Registry,
    loader: Arc<dyn DayLoader>,
    days: Mutex<VecDeque<(Day, Option<Arc<DayPrices>>)>>,
}

impl ClosedDayPrices {
    pub fn new(registry: &'static Registry, loader: Arc<dyn DayLoader>) -> Self {
        Self { registry, loader, days: Mutex::new(VecDeque::new()) }
    }

    pub fn peek(&self, asset: &str, at_ms: f64) -> Peek {
        let day = utc_day(at_ms);
        let days = self.days.lock();
        match days.iter().find(|((a, d), _)| a == asset && *d == day) {
            None => Peek::Unloaded,
            Some((_, None)) => Peek::NoArchive,
            Some((_, Some(p))) => Peek::Price(p.at(at_ms)),
        }
    }

    /// Fetches the asset's prices for the day of `at_ms`. An error caches
    /// nothing, so the caller's retry asks again.
    pub async fn load(&self, asset: &str, at_ms: f64) -> Result<(), ArchiveError> {
        let key = (asset.to_string(), utc_day(at_ms));
        if self.days.lock().iter().any(|(k, _)| *k == key) {
            return Ok(());
        }
        let day = self.loader.load(&key.0, &key.1).await?.map(Arc::new);
        let mut days = self.days.lock();
        if !days.iter().any(|(k, _)| *k == key) {
            days.push_back((key, day));
        }
        while days.len() > DAYS_KEPT {
            days.pop_front();
        }
        Ok(())
    }

    /// A pricer whose asset prices are those of `at_ms` where the archives
    /// answer, and `live`'s where none will. Pair mids stay live: decode does
    /// not price with them.
    pub fn pricer<'a>(&'a self, at_ms: f64, live: &'a dyn Pricer) -> ClosedDayPricer<'a> {
        ClosedDayPricer {
            prices: self,
            at_ms,
            live,
            unloaded: Mutex::new(Vec::new()),
            from_live: Mutex::new(Vec::new()),
        }
    }

    /// Runs `decode` with a pricer as of `at_ms`, loading whatever asset-days
    /// it asks for, and returns what it returned. `decode` may run more than
    /// once and must return the same thing for the same prices. An asset no
    /// archive answers for keeps the live price and is reported through
    /// `on_live`. Errors are `load`'s: the caller holds its cursor on them,
    /// exactly as for a block it couldn't read.
    pub async fn decode<T>(
        &self,
        at_ms: f64,
        live: &dyn Pricer,
        mut decode: impl FnMut(&dyn Pricer) -> T,
        mut on_live: impl FnMut(&str),
    ) -> Result<T, ArchiveError> {
        for _ in 0..MAX_PASSES {
            let unloaded = {
                let p = self.pricer(at_ms, live);
                let out = decode(&p);
                let unloaded = std::mem::take(&mut *p.unloaded.lock());
                if unloaded.is_empty() {
                    for asset in p.from_live.lock().iter() {
                        on_live(asset);
                    }
                    return Ok(out);
                }
                unloaded
            };
            for asset in unloaded {
                self.load(&asset, at_ms).await?;
            }
        }
        Err(ArchiveError::Io("closed-day prices: decode kept asking for unloaded prices".into()))
    }
}

/// The pricer `ClosedDayPrices::pricer` hands decode.
pub struct ClosedDayPricer<'a> {
    prices: &'a ClosedDayPrices,
    at_ms: f64,
    live: &'a dyn Pricer,
    unloaded: Mutex<Vec<String>>,
    from_live: Mutex<Vec<String>>,
}

impl ClosedDayPricer<'_> {
    /// The archive's price for a token's asset; `Err` = ask live.
    fn asset_price(&self, token_key: &str) -> Result<f64, ()> {
        let r = self.prices.registry;
        let Some(asset) = r.tokens.get(token_key).and_then(|t| r.asset_for_token(&t.address)) else { return Err(()) };
        match self.prices.peek(&asset.key, self.at_ms) {
            Peek::Price(px) => Ok(px),
            Peek::NoArchive => {
                let mut l = self.from_live.lock();
                if !l.contains(&asset.key) {
                    l.push(asset.key.clone());
                }
                Err(())
            }
            // Any positive number: this pass is thrown away. Not the live
            // price, which may be 0 while a feed warms and would make decode
            // fail a trade the archive can price.
            Peek::Unloaded => {
                let mut u = self.unloaded.lock();
                if !u.contains(&asset.key) {
                    u.push(asset.key.clone());
                }
                Ok(1.0)
            }
        }
    }

    fn stable(&self, token_key: &str) -> Option<bool> {
        self.prices.registry.tokens.get(token_key).map(|t| t.stable)
    }
}

impl Pricer for ClosedDayPricer<'_> {
    fn usd_per_token(&self, token_key: &str) -> f64 {
        match self.stable(token_key) {
            None => 0.0,
            Some(true) => 1.0,
            Some(false) => self.asset_price(token_key).unwrap_or_else(|()| self.live.usd_per_token(token_key)),
        }
    }

    fn usd_for_token(&self, token_key: &str, amount: f64) -> f64 {
        match self.stable(token_key) {
            None => 0.0,
            Some(true) => amount,
            Some(false) => match self.asset_price(token_key) {
                Ok(px) => amount * px,
                Err(()) => self.live.usd_for_token(token_key, amount),
            },
        }
    }

    fn pair_mid(&self, market: &str) -> f64 {
        self.live.pair_mid(market)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::archives::Points;

    /// 2026-10-14T09:30:00Z.
    const T: f64 = 1_791_970_200_000.0;

    fn flat(px: f64) -> DayPrices {
        let mut p = Points::default();
        p.push(0.0, px);
        DayPrices::new(&p, false).unwrap()
    }

    /// The live reference on the day of the replay: MON has halved since.
    struct Live(f64);
    impl Pricer for Live {
        fn usd_per_token(&self, k: &str) -> f64 {
            match k {
                "WMON" | "MON" => self.0,
                "WETH" => 1_800.0,
                "USDC" => 1.0,
                _ => 0.0,
            }
        }
        fn usd_for_token(&self, k: &str, a: f64) -> f64 {
            a * self.usd_per_token(k)
        }
        fn pair_mid(&self, _: &str) -> f64 {
            7.0
        }
    }

    type LoadFn = dyn Fn(&str, &str) -> Result<Option<DayPrices>, ArchiveError> + Send + Sync;

    struct Loader {
        f: Box<LoadFn>,
        calls: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl DayLoader for Loader {
        async fn load(&self, a: &str, d: &str) -> Result<Option<DayPrices>, ArchiveError> {
            self.calls.lock().push((a.into(), d.into()));
            (self.f)(a, d)
        }
    }

    fn prices(
        f: impl Fn(&str, &str) -> Result<Option<DayPrices>, ArchiveError> + Send + Sync + 'static,
    ) -> (ClosedDayPrices, Arc<Loader>) {
        let l = Arc::new(Loader { f: Box::new(f), calls: Mutex::new(Vec::new()) });
        (ClosedDayPrices::new(Registry::get(), l.clone()), l)
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }

    #[test]
    fn values_a_leg_at_the_archived_price_of_its_day() {
        let (p, l) = prices(|a, d| Ok((a == "MON" && d == "2026-10-14").then(|| flat(0.0244))));
        let usd = block_on(p.decode(T, &Live(0.015), |pr| pr.usd_for_token("WMON", 10_000.0), |_| {})).unwrap();
        assert!((usd - 244.0).abs() < 1e-9, "live would say 150");
        assert_eq!(*l.calls.lock(), vec![("MON".to_string(), "2026-10-14".to_string())]);
        assert_eq!(p.pricer(T, &Live(0.015)).pair_mid("MON/USDC"), 7.0, "pair mids stay live");
    }

    #[test]
    fn reads_the_instant_and_keys_the_day_in_utc() {
        let (p, _) = prices(|_, d| {
            Ok(match d {
                "2026-10-14" => {
                    let mut pts = Points::default();
                    pts.push(0.0, 0.0250);
                    pts.push(T, 0.0240);
                    DayPrices::new(&pts, false)
                }
                "2026-10-15" => Some(flat(0.0230)),
                _ => None,
            })
        });
        let at = |t: f64| block_on(p.decode(t, &Live(0.015), |pr| pr.usd_for_token("WMON", 1.0), |_| {})).unwrap();
        assert_eq!(at(T - 1.0), 0.0250);
        assert_eq!(at(T), 0.0240);
        assert_eq!(at(1_792_022_399_999.0), 0.0240, "2026-10-14T23:59:59.999Z");
        assert_eq!(at(1_792_022_400_000.0), 0.0230, "2026-10-15T00:00:00Z");
    }

    #[test]
    fn a_stable_quoted_decode_fetches_nothing_and_runs_once() {
        let (p, l) = prices(|_, _| Ok(Some(flat(1.0))));
        let runs = AtomicUsize::new(0);
        let usd = block_on(p.decode(
            T,
            &Live(0.015),
            |pr| {
                runs.fetch_add(1, Ordering::Relaxed);
                pr.usd_for_token("USDC", 168.286102)
            },
            |_| {},
        ))
        .unwrap();
        assert_eq!(usd, 168.286102);
        assert!(l.calls.lock().is_empty());
        assert_eq!(runs.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn decodes_again_once_loaded_then_once_per_block() {
        let (p, l) = prices(|_, _| Ok(Some(flat(0.0244))));
        let runs = AtomicUsize::new(0);
        let dec = |pr: &dyn Pricer| {
            runs.fetch_add(1, Ordering::Relaxed);
            pr.usd_for_token("WMON", 100.0)
        };
        block_on(p.decode(T, &Live(0.015), dec, |_| {})).unwrap();
        assert_eq!(runs.load(Ordering::Relaxed), 2, "the first pass only found out what to load");
        block_on(p.decode(T + 300_000.0, &Live(0.015), dec, |_| {})).unwrap();
        assert_eq!(runs.load(Ordering::Relaxed), 3);
        assert_eq!(l.calls.lock().len(), 1);
    }

    #[test]
    fn the_first_pass_never_sees_a_cold_live_price() {
        let (p, _) = prices(|_, _| Ok(Some(flat(0.0244))));
        // Decode fails a trade with no USD (btr: "no USD price for either leg").
        let strict = |pr: &dyn Pricer| {
            let usd = pr.usd_for_token("WMON", 100.0);
            (usd > 0.0).then_some(usd).ok_or("no USD price")
        };
        let usd = block_on(p.decode(T, &Live(0.0), strict, |_| {})).unwrap().unwrap();
        assert!((usd - 2.44).abs() < 1e-9);
    }

    #[test]
    fn keeps_the_live_price_where_no_archive_answers_and_says_which() {
        let (p, _) = prices(|_, _| Ok(None));
        let mut live = Vec::new();
        let usd =
            block_on(p.decode(T, &Live(0.015), |pr| pr.usd_for_token("WMON", 10_000.0), |a| live.push(a.to_string())))
                .unwrap();
        assert_eq!(usd, 150.0);
        assert_eq!(live, ["MON"]);
    }

    #[test]
    fn loads_what_a_second_pass_turns_to() {
        // SPYx (Kraken) has no archive and its live feed is cold, so decode
        // falls back to the other leg.
        let (p, l) = prices(|a, _| Ok((a == "ETH").then(|| flat(2_500.0))));
        let usd = block_on(p.decode(
            T,
            &Live(0.015),
            |pr| {
                let spy = pr.usd_for_token("SPYX", 2.0);
                if spy > 0.0 {
                    spy
                } else {
                    pr.usd_for_token("WETH", 0.4)
                }
            },
            |_| {},
        ))
        .unwrap();
        assert_eq!(usd, 1_000.0);
        let assets: Vec<String> = l.calls.lock().iter().map(|c| c.0.clone()).collect();
        assert_eq!(assets, ["SPYx", "ETH"]);
    }

    #[test]
    fn an_unpublished_archive_holds_and_is_asked_again() {
        let published = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = published.clone();
        let (p, l) = prices(move |_, d| {
            if flag.load(Ordering::Relaxed) {
                Ok(Some(flat(0.0244)))
            } else {
                Err(ArchiveError::NotPublished { symbol: "MONUSDT".into(), day: d.into() })
            }
        });
        let mut live = Vec::new();
        let e = block_on(p.decode(T, &Live(0.015), |pr| pr.usd_for_token("WMON", 100.0), |a| live.push(a.to_string())))
            .unwrap_err();
        assert!(e.to_string().contains("not published yet"), "{e}");
        assert!(live.is_empty(), "held, never priced from today");
        published.store(true, Ordering::Relaxed);
        let usd = block_on(p.decode(T, &Live(0.015), |pr| pr.usd_for_token("WMON", 100.0), |_| {})).unwrap();
        assert!((usd - 2.44).abs() < 1e-9);
        assert_eq!(l.calls.lock().len(), 2);
    }

    #[test]
    fn sizing_reads_the_same_prices() {
        let (p, _) = prices(|_, _| Ok(Some(flat(0.02))));
        block_on(p.load("MON", T)).unwrap();
        let pr = p.pricer(T, &Live(0.015));
        assert_eq!(pr.usd_per_token("WMON"), 0.02);
        assert_eq!(pr.token_for_usd("WMON", 1.0), 50.0);
        assert_eq!(pr.usd_per_token("USDC"), 1.0);
        assert_eq!(pr.usd_per_token("NOPE"), 0.0);
        assert_eq!(pr.usd_for_token("NOPE", 3.0), 0.0);
    }
}
