use mpamm_registry::{Cex, Registry};

use super::{kraken::Kraken, *};
use crate::reference::Exchanges;

const T: u64 = 1_795_762_800_000;

#[test]
fn symbols_follow_the_registry() {
    let (bybit, binance, kraken) = symbols_for(Registry::get());
    assert_eq!(bybit, ["MONUSDT", "USDCUSDT", "USD1USDT"]);
    for s in ["BTCUSDT", "ETHUSDT", "XAUTUSDT", "WBTCBTC", "USDCUSDT"] {
        assert!(binance.iter().any(|x| x == s), "binance lacks {s}: {binance:?}");
    }
    for s in ["USDT/USD", "SPYx/USD", "ANTx/USD", "USDC/USD", "AUSD/USD"] {
        assert!(kraken.iter().any(|x| x == s), "kraken lacks {s}: {kraken:?}");
    }
}

#[test]
fn bybit_book_deltas_tickers_and_crosses() {
    let ex = Exchange::new(Cex::Bybit, &["MONUSDT".into(), "USDCUSDT".into()]);
    bybit::apply(
        &ex,
        r#"{"topic":"orderbook.50.MONUSDT","type":"snapshot","data":{"s":"MONUSDT","b":[["0.0299","1000"],["0.0298","5000"]],"a":[["0.0301","1000"],["0.0302","5000"]]}}"#,
        T,
    );
    assert_eq!(ex.mid("MONUSDT", T), 0.03);
    bybit::apply(
        &ex,
        r#"{"topic":"orderbook.50.MONUSDT","type":"delta","data":{"b":[["0.0299","0"],["0.03","10"]],"a":[]}}"#,
        T + 1,
    );
    assert!((ex.mid("MONUSDT", T + 1) - 0.03005).abs() < 1e-12);
    let w = ex.walk("MONUSDT", Side::Sell, 20.0, T + 1);
    assert!((w.price - (10.0 * 0.03 + 10.0 * 0.0298) / 20.0).abs() < 1e-12 && w.filled_full);
    bybit::apply(
        &ex,
        r#"{"topic":"tickers.USDCUSDT","data":{"symbol":"USDCUSDT","lastPrice":"1.0001","bid1Price":"1.0000","ask1Price":"1.0004","price24hPcnt":"0.0001"}}"#,
        T + 2,
    );
    assert!((ex.mid("USDCUSDT", T + 2) - 1.0002).abs() < 1e-12);
    assert!((ex.change_pct("USDCUSDT", T + 2) - 0.01).abs() < 1e-12);
    // The real spot ticker has no bid or ask: the cross's top of book comes
    // from orderbook.1 (as recorded from Bybit), and moves with it.
    bybit::apply(&ex, r#"{"topic":"tickers.USDCUSDT","type":"snapshot","data":{"symbol":"USDCUSDT","lastPrice":"1.0012","price24hPcnt":"0.0002"}}"#, T + 3);
    assert!((ex.mid("USDCUSDT", T + 3) - 1.0002).abs() < 1e-12, "a ticker alone doesn't move the cross's book");
    bybit::apply(&ex, r#"{"topic":"orderbook.1.USDCUSDT","type":"snapshot","data":{"s":"USDCUSDT","b":[["1.0012","11509291.94"]],"a":[["1.0013","6799687.2"]],"u":776389}}"#, T + 4);
    assert!((ex.mid("USDCUSDT", T + 4) - 1.00125).abs() < 1e-12);
    assert_eq!(ex.mid("MONUSDT", T + 4 + STALE_MS + 1), 0.0, "a silent feed is unavailable");
    assert_eq!(ex.mid_at("MONUSDT", (T + 1) as f64, 1e9), Some(0.03005));
    assert_eq!(ex.mid_at("MONUSDT", T as f64, 1e9), Some(0.03));
}

#[test]
fn binance_depth_and_book_ticker() {
    let ex = Exchange::new(Cex::Binance, &["BTCUSDT".into()]);
    binance::apply(
        &ex,
        r#"{"stream":"btcusdt@depth20@100ms","data":{"bids":[["89990.00","0.5"]],"asks":[["90010.00","0.5"]]}}"#,
        T,
    );
    assert_eq!(ex.mid("BTCUSDT", T), 90_000.0);
    binance::apply(
        &ex,
        r#"{"stream":"btcusdt@bookTicker","data":{"s":"BTCUSDT","b":"89995.00","a":"90005.00"}}"#,
        T + 1,
    );
    assert_eq!(ex.mid("BTCUSDT", T + 1), 90_000.0);
    binance::apply(&ex, r#"{"stream":"btcusdt@bookTicker","data":{"b":"90000.00","a":"90010.00"}}"#, T + 2);
    assert_eq!(ex.mid("BTCUSDT", T + 2), 90_005.0);
    assert!(!ex.walk("BTCUSDT", Side::Buy, 1.0, T + 2).filled_full, "the book holds only 0.5");
}

fn kraken() -> (Arc<Exchange>, Kraken) {
    let syms: Vec<String> = ["BTC/USD", "SPYx/USD"].into_iter().map(String::from).collect();
    (Exchange::new(Cex::Kraken, &syms), Kraken::new(syms))
}

fn online(ex: &Exchange, k: &mut Kraken) {
    k.apply(ex, r#"{"channel":"status","type":"update","data":[{"system":"online"}]}"#, T).unwrap();
    k.apply(ex, r#"{"channel":"instrument","type":"snapshot","data":{"pairs":[{"symbol":"BTC/USD","status":"online"},{"symbol":"SPYx/USD","status":"online"}]}}"#, T).unwrap();
}

/// Real messages recorded from Kraken: every checksum must verify against
/// the books as applied, decimal text and all.
#[test]
fn kraken_books_verify_kraken_checksums() {
    let (ex, mut k) = kraken();
    online(&ex, &mut k);
    let lines = include_str!("../../tests/fixtures/kraken-book-v2.jsonl");
    for line in lines.lines().filter(|l| !l.is_empty()) {
        let out = k.apply(&ex, line, T).expect("message applies");
        assert!(out.is_empty(), "no repair requested: {out:?}");
    }
    for sym in ["BTC/USD", "SPYx/USD"] {
        assert!(ex.read(sym, |s| s.has_book).unwrap(), "{sym} has a verified book");
        let mid = ex.mid(sym, T);
        assert!(mid > 0.0, "{sym} mid");
        let w = ex.walk(sym, Side::Buy, 0.001, T);
        assert!(w.filled_full && w.price >= mid);
    }
}

#[test]
fn kraken_checksum_failure_repairs_only_that_book() {
    let (ex, mut k) = kraken();
    online(&ex, &mut k);
    let lines: Vec<&str> = include_str!("../../tests/fixtures/kraken-book-v2.jsonl").lines().collect();
    for l in &lines {
        k.apply(&ex, l, T).unwrap();
    }
    // An update with a wrong checksum drops the book and starts a repair.
    let out = k
        .apply(
            &ex,
            r#"{"channel":"book","type":"update","data":[{"symbol":"BTC/USD","bids":[],"asks":[],"checksum":1}]}"#,
            T + 1,
        )
        .unwrap();
    assert_eq!(out.len(), 1);
    let req: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
    assert_eq!((req["method"].as_str(), req["params"]["symbol"][0].as_str()), (Some("unsubscribe"), Some("BTC/USD")));
    assert_eq!(ex.mid("BTC/USD", T + 1), 0.0, "no reference while broken");
    assert!(ex.mid("SPYx/USD", T + 1) > 0.0, "the other book keeps quoting");
    // Updates while repairing are ignored; the unsubscribe ack asks for a snapshot.
    let id = req["req_id"].as_u64().unwrap();
    let out = k.apply(&ex, &format!(r#"{{"method":"unsubscribe","req_id":{id},"success":true}}"#), T + 2).unwrap();
    let sub: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
    assert_eq!((sub["method"].as_str(), sub["params"]["snapshot"].as_bool()), (Some("subscribe"), Some(true)));
    // The recorded BTC snapshot verifies and ends the repair.
    let snapshot = lines.iter().find(|l| l.contains(r#""type":"snapshot""#) && l.contains("BTC/USD")).unwrap();
    assert!(k.apply(&ex, snapshot, T + 3).unwrap().is_empty());
    assert!(ex.mid("BTC/USD", T + 3) > 0.0);
    assert!(
        k.apply(&ex, "{}", T + 100_000).unwrap().is_empty() && ws::Session::tick(&mut k, &ex, T + 100_000).is_empty(),
        "nothing left to repair"
    );
}

#[test]
fn kraken_status_closures_and_settled_prices() {
    let (ex, mut k) = kraken();
    online(&ex, &mut k);
    for l in include_str!("../../tests/fixtures/kraken-book-v2.jsonl").lines() {
        k.apply(&ex, l, T).unwrap();
    }
    let live = ex.mid("SPYx/USD", T);
    k.apply(
        &ex,
        r#"{"channel":"instrument","type":"update","data":{"pairs":[{"symbol":"SPYx/USD","status":"cancel_only"}]}}"#,
        T + 1,
    )
    .unwrap();
    assert_eq!(ex.mid("SPYx/USD", T + 1), 0.0, "no reference while closed");
    assert!(ex.market_closed("SPYx/USD", T + 1));
    assert_eq!(ex.settled_mid("SPYx/USD", T + 1), live, "settled trades keep the last good mid");
    k.apply(&ex, r#"{"channel":"status","type":"update","data":[{"system":"maintenance"}]}"#, T + 2).unwrap();
    assert!(ex.market_closed("BTC/USD", T + 2) && ex.mid("BTC/USD", T + 2) == 0.0);
    // A rejected symbol only takes its own book down.
    k.apply(&ex, r#"{"channel":"status","type":"update","data":[{"system":"online"}]}"#, T + 3).unwrap();
    k.apply(
        &ex,
        r#"{"method":"subscribe","success":false,"symbol":"BTC/USD","error":"Currency pair not supported"}"#,
        T + 3,
    )
    .unwrap();
    assert_eq!(ex.mid("BTC/USD", T + 3), 0.0);
    assert!(
        k.apply(&ex, r#"{"method":"subscribe","success":false,"error":"rate limited"}"#, T + 3).is_err(),
        "an unscoped failure reconnects"
    );
}

#[test]
fn the_feeds_as_of_a_past_time() {
    let feeds = Feeds::new(Registry::get());
    bybit::apply(&feeds.bybit, r#"{"topic":"tickers.MONUSDT","data":{"bid1Price":"0.0299","ask1Price":"0.0301"}}"#, T);
    bybit::apply(
        &feeds.bybit,
        r#"{"topic":"tickers.MONUSDT","data":{"bid1Price":"0.0309","ask1Price":"0.0311"}}"#,
        T + 60_000,
    );
    let at = feeds.at((T + 30_000) as f64);
    assert!((at.mid(Cex::Bybit, "MONUSDT") - 0.03).abs() < 1e-12);
    assert!((feeds.at((T + 60_000) as f64).mid(Cex::Bybit, "MONUSDT") - 0.031).abs() < 1e-12);
    assert_eq!(feeds.at((T - 1) as f64).mid(Cex::Bybit, "MONUSDT"), 0.0, "before the history starts");
    assert!(feeds.at((T + 600_000) as f64).mid(Cex::Bybit, "MONUSDT") > 0.0, "a quiet book is still the price");
    feeds.bybit.reset_books();
    assert_eq!(feeds.at(now_ms() as f64 + 1.0).mid(Cex::Bybit, "MONUSDT"), 0.0, "not across an outage");
}
