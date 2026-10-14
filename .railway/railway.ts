// Railway Infrastructure as Code — the successor to render.yaml (and to the
// legacy railway.json, which new Railway services never read). Same shape as
// production on Render: one always-on container built from the Dockerfile,
// serving REST/WS + the built frontend on one origin, with the SQLite history
// on a volume at /data (DB_PATH=/data/mpamm.db and WEB_DIST are baked into the
// Dockerfile's ENV; $PORT → API_PORT is mapped in its CMD).
//
//   railway config plan     # read-only diff against the linked environment
//   railway config apply    # needs Railway CLI >= 5.42.1
//
// Names match the live service (`railway config pull`): renaming either the
// service or the volume here makes `apply` create a NEW one beside it, with an
// empty /data. The first boot on Railway must run on a copy of production's
// SQLite history — an empty volume re-runs every venue-lifetime backfill from
// scratch (docs/deploy.md → Railway bootstrap).
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // Single-writer SQLite: one replica, and the volume forbids more anyway.
  // Virginia keeps the quote critical path next to the hot RPC (as on Render);
  // a volume follows its service's region, and moving it later is an offline
  // migration of the whole history. Size/region pinned to the live volume:
  // left unset, a plan proposes clearing them (and volumes can't shrink).
  const data = volume("mpamm-virginia-mpamm-data-virginia", { region: "us-east4-eqdc4a", sizeMB: 50_000 });

  const mpamm = service("mpamm-virginia", {
    source: github("haythemsellami/mpamm.wtf", { branch: "main", rootDirectory: "." }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    replicas: { "us-east4-eqdc4a": 1 },
    // Proves only that the process bound $PORT. index.ts binds BEFORE
    // source.start() (RPC probe, discovery, initHistory) so clients get empty
    // snapshots rather than refusals during warm-up, and /api/health answers
    // 200 throughout — so this does not wait for, or bound, the boot. A boot
    // that fails afterwards exits non-zero and restartPolicy retries it. A
    // readiness gate would buy nothing here: the volume already forces the old
    // deploy down before this one starts. Railway never re-probes a live deploy.
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      // SIGTERM → final SQLite flush, force-exit after 5s (server/src/index.ts);
      // SIGKILL must not land first.
      drainingSeconds: 10,
    },
    env: {
      DATA_SOURCE: "live",
      // cap the JS heap well under the instance limit (parity with Render)
      NODE_OPTIONS: "--max-old-space-size=320",
      // staged rollout; enable every-head depth after a capacity check
      DEPTH_MIN_INTERVAL_MS: "1000",
      // Secrets: set with `railway variable set`, never in this file. The URLs
      // are DIFFERENT jobs (docs/deploy.md): hot = tip freshness, depth = curve
      // capacity isolation, archive = retention. Unset secondaries reuse hot.
      RPC_HTTP_URL: preserve(),
      RPC_WS_URL: preserve(),
      RPC_DEPTH_URL: preserve(),
      RPC_DEPTH_WS_URL: preserve(),
      RPC_ARCHIVE_URL: preserve(),
    },
    volumeMounts: { "/data": data },
  });

  return project("mpamm", { resources: [mpamm, data] });
});
