use std::{os::unix::fs::PermissionsExt, path::Path};

use super::*;

const METRICS: &str = r#"# HELP litestream_txid Current transaction ID
# TYPE litestream_txid gauge
litestream_txid{db="/var/lib/mpamm/data/mpamm.db"} 4242
litestream_db_size{db="/var/lib/mpamm/data/mpamm.db"} 3.49233152e+08
litestream_wal_size{db="/var/lib/mpamm/data/mpamm.db"} 4.190072e+06
litestream_sync_count{db="/var/lib/mpamm/data/mpamm.db"} 150
litestream_sync_error_count{db="/var/lib/mpamm/data/mpamm.db"} 2
litestream_checkpoint_count{db="/var/lib/mpamm/data/mpamm.db",mode="PASSIVE"} 60
litestream_checkpoint_count{db="/var/lib/mpamm/data/mpamm.db",mode="TRUNCATE"} 1
litestream_replica_operation_total{replica_type="s3",operation="PUT"} 100
litestream_replica_operation_total{replica_type="s3",operation="GET"} 25
litestream_replica_operation_bytes{replica_type="s3",operation="PUT"} 52428800
litestream_replica_operation_errors_total{replica_type="s3",operation="DELETE",code="AccessDenied"} 1
go_goroutines 42
"#;

#[test]
fn metrics_sum_the_copiers_series() {
    let m = parse_metrics(METRICS);
    assert_eq!(
        m,
        Metrics {
            txid: 4242,
            db_bytes: 349_233_152,
            wal_bytes: 4_190_072,
            syncs: 150,
            sync_errors: 2,
            checkpoints: 61,
            puts: Some(100),
            put_bytes: 52_428_800,
            replica_errors: 1,
        }
    );
    // A file replica: Litestream counts no uploads.
    assert_eq!(parse_metrics("litestream_txid{db=\"/x y.db\"} 7\n").puts, None);
    assert_eq!(parse_metrics("litestream_txid{db=\"/x y.db\"} 7\n").txid, 7, "a label with a space");
    assert_eq!(parse_metrics("garbage\nlitestream_txid NaN\n"), Metrics::default());
}

#[test]
fn log_lines_keep_their_level_and_lose_the_time() {
    let (k, t) = classify(
        r#"time=2026-11-28T10:00:00.000Z level=ERROR msg="monitor error" db=/d/mpamm.db error="AccessDenied""#,
    );
    assert_eq!(k, Line::Error);
    assert_eq!(t, r#"level=ERROR msg="monitor error" db=/d/mpamm.db error="AccessDenied""#);
    assert_eq!(classify("time=x level=WARN msg=slow").0, Line::Warn);
    assert_eq!(classify("time=x level=INFO msg=\"replica sync recovered\" previous_errors=3").0, Line::Recovered);
    assert_eq!(classify("time=x level=INFO msg=\"sync recovered\" previous_errors=2").0, Line::Recovered);
    assert_eq!(classify("time=x level=INFO msg=\"compaction complete\" level=1").0, Line::Info);
    assert_eq!(classify("time=x level=DEBUG msg=sync").0, Line::Debug);
    assert_eq!(classify("error: cannot open config file").0, Line::Error, "before the logger is up");
    assert_eq!(classify("litestream v0.5.18").0, Line::Info);
}

fn view(state: &'static str, for_ms: u64) -> ReplicationView {
    ReplicationView {
        state,
        reason: None,
        for_ms,
        starts: 1,
        last_exit: None,
        errors: 0,
        last_error: None,
        last_error_age_ms: None,
        error_open: false,
        metrics: Some(Metrics::default()),
        metrics_age_ms: Some(1_000),
        txid_age_ms: Some(1_000),
        puts_age_ms: None,
    }
}

#[test]
fn trouble_names_what_needs_a_human() {
    let now = 10_000_000;
    let committing = now - 400;
    assert_eq!(trouble(&view("running", 600_000), committing, now), None, "all well");

    let off = ReplicationView { reason: Some("no replica URL (MPAMM_REPLICA_URL)".into()), ..view("off", 0) };
    assert!(trouble(&off, committing, now).unwrap().contains("MPAMM_REPLICA_URL"));

    assert_eq!(trouble(&view("restarting", 5_000), committing, now), None, "a quick restart");
    let down = ReplicationView {
        last_exit: Some("litestream exited (exit status: 1): bad bucket".into()),
        ..view("restarting", 45_000)
    };
    assert!(trouble(&down, committing, now).unwrap().contains("bad bucket"));
    assert!(trouble(&view("waiting", 45_000), committing, now).unwrap().contains("previous copier"));

    let err = ReplicationView {
        errors: 3,
        last_error: Some("level=ERROR msg=\"monitor error\"".into()),
        last_error_age_ms: Some(2_000),
        error_open: true,
        ..view("running", 600_000)
    };
    assert!(trouble(&err, committing, now).unwrap().contains("monitor error"));
    let recovered = ReplicationView { error_open: false, ..err.clone() };
    assert_eq!(trouble(&recovered, committing, now), None, "recovered since");
    let old = ReplicationView { last_error_age_ms: Some(ERROR_MS + 1), ..err };
    assert_eq!(trouble(&old, committing, now), None, "an old error");

    let stuck = ReplicationView { txid_age_ms: Some(STUCK_MS + 1_000), ..view("running", 600_000) };
    assert!(trouble(&stuck, committing, now).unwrap().contains("hasn't moved"));
    assert_eq!(trouble(&stuck, now - 60_000, now), None, "a quiet chain moves nothing");
    let no_metrics = ReplicationView { metrics: None, txid_age_ms: None, ..view("running", 600_000) };
    assert!(trouble(&no_metrics, committing, now).unwrap().contains("no metrics"));
    let no_uploads = ReplicationView { puts_age_ms: Some(STUCK_MS + 1_000), ..view("running", 600_000) };
    assert!(trouble(&no_uploads, committing, now).unwrap().contains("object storage"));
    let young = ReplicationView { txid_age_ms: Some(STUCK_MS + 1_000), ..view("running", 60_000) };
    assert_eq!(trouble(&young, committing, now), None, "just started");
}

#[test]
fn stats_track_restarts_errors_and_movement() {
    let s = ReplicationStats::new();
    s.started(1_000);
    s.line(Line::Error, "level=ERROR msg=\"cannot open store\" error=https://key@host/x", 1_100);
    s.exited("litestream exited (exit status: 1)".into(), 1_200);
    let v = s.view(2_000);
    assert_eq!((v.state, v.starts, v.errors, v.for_ms), ("restarting", 1, 1, 800));
    let exit = v.last_exit.unwrap();
    assert!(exit.contains("cannot open store") && exit.contains("<rpc>") && !exit.contains("key@"), "{exit}");
    assert!(v.error_open);

    s.started(3_000);
    s.line(Line::Recovered, "level=INFO msg=\"replica sync recovered\"", 3_100);
    s.metrics(Metrics { txid: 5, ..Metrics::default() }, 3_200);
    s.metrics(Metrics { txid: 5, ..Metrics::default() }, 8_200);
    let v = s.view(9_000);
    assert_eq!((v.state, v.starts, v.error_open), ("running", 2, false));
    assert_eq!((v.txid_age_ms, v.puts_age_ms, v.metrics_age_ms), (Some(5_800), None, Some(800)));
    s.metrics(Metrics { txid: 6, puts: Some(1), ..Metrics::default() }, 9_500);
    let v = s.view(10_000);
    assert_eq!((v.txid_age_ms, v.puts_age_ms), (Some(500), Some(500)));
}

#[test]
fn the_lock_sits_beside_the_database() {
    assert_eq!(
        lock_path(Path::new("/var/lib/mpamm/data/mpamm.db")),
        Path::new("/var/lib/mpamm/data/.mpamm.db-litestream.lock")
    );
}

/// A stand-in for Litestream: `mode` says whether it crashes or runs; it
/// records its arguments and environment, and a SIGTERM makes it log a
/// final sync and exit.
fn fake_copier(dir: &Path) -> PathBuf {
    let bin = dir.join("litestream");
    let d = dir.display();
    std::fs::write(
        &bin,
        format!(
            r#"#!/bin/sh
echo "$* db=$MPAMM_DB url=$MPAMM_REPLICA_URL addr=$MPAMM_LITESTREAM_ADDR key=$LITESTREAM_ACCESS_KEY_ID" >> {d}/calls
case $(cat {d}/mode) in
  crash)
    echo 'time=2026-11-28T10:00:00Z level=ERROR msg="cannot open store" error="NoSuchBucket"'
    exit 1 ;;
  *)
    trap 'echo "time=2026-11-28T10:00:01Z level=INFO msg=\"final sync\""; echo stopped >> {d}/calls; exit 0' TERM
    echo 'time=2026-11-28T10:00:00Z level=INFO msg="initialized db"'
    echo ready >> {d}/calls
    while :; do sleep 0.05; done ;;
esac
"#
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

async fn until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_copier_restarts_holds_its_lock_and_finishes_its_sync() {
    let dir = std::env::temp_dir().join(format!("mpamm-replication-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let bin = fake_copier(&dir);
    std::fs::write(dir.join("mode"), "crash").unwrap();
    // The copier's metrics: a stand-in for Litestream's listener.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().route("/metrics", axum::routing::get(|| async { METRICS }));
    tokio::spawn(async move { axum::serve(listener, app).await });

    let cfg = Config {
        bin,
        config: dir.join("litestream.yml"),
        addr,
        db: dir.join("mpamm.db"),
        replica_url: "file:///replica/mpamm".into(),
        restart_min: Duration::from_millis(50),
    };
    let calls = || std::fs::read_to_string(dir.join("calls")).unwrap_or_default();
    let first = ReplicationStats::new();
    let (stop_first, rx) = watch::channel(false);
    let a = tokio::spawn(run(cfg.clone(), first.clone(), rx));

    // A copier that can't start is restarted, with its reason kept.
    until("two failed starts", || first.view(now_ms()).starts >= 2).await;
    let v = first.view(now_ms());
    assert!(v.errors >= 1);
    until("the exit's reason", || first.view(now_ms()).last_exit.is_some_and(|e| e.contains("NoSuchBucket"))).await;

    // Then it runs, with the database, the replica and the metrics address.
    std::fs::write(dir.join("mode"), "run").unwrap();
    until("a running copier", || first.view(now_ms()).state == "running").await;
    until("the copier's signal handler", || calls().contains("ready")).await;
    until("its metrics", || first.view(now_ms()).metrics.is_some_and(|m| m.txid == 4242)).await;
    let line = calls().lines().rfind(|l| l.starts_with("replicate")).unwrap().to_string();
    assert!(line.starts_with(&format!("replicate -config {}", cfg.config.display())), "{line}");
    assert!(line.contains(&format!("db={}", cfg.db.display())) && line.contains("url=file:///replica/mpamm"), "{line}");
    assert!(line.contains(&format!("addr={addr}")), "{line}");

    // A second service on the same database waits for the lock.
    let second = ReplicationStats::new();
    let (stop_second, rx) = watch::channel(false);
    let b = tokio::spawn(run(cfg.clone(), second.clone(), rx));
    until("the second to wait", || second.view(now_ms()).state == "waiting").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(second.view(now_ms()).starts, 0, "never two copiers on one database");

    // Stopping the first lets its copier finish its sync, then frees the lock.
    stop_first.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(5), a).await.expect("stops").unwrap();
    assert!(calls().contains("stopped"), "SIGTERM reached the copier");
    until("the second to start", || second.view(now_ms()).state == "running").await;
    until("its signal handler", || calls().matches("ready").count() == 2).await;
    stop_second.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(5), b).await.expect("stops").unwrap();
    assert_eq!(calls().matches("stopped").count(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}
