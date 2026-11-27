//! Content-addressed leaderboard artifacts (today's `AnalyticsPublications`):
//! `/api/leaderboard/publication` names the current artifact of a window and
//! `/api/analytics/<sha256>.json` serves it as immutable, so a CDN or browser
//! cache can keep it forever. A corrected markout gets a new revision; an
//! unchanged recomputation keeps the old one (its URL and its `generatedAt`),
//! so it never forces another download.

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::Arc;

use bytes::Bytes;
use indexmap::IndexMap;
use mpamm_types::LeaderboardResponse;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::SourceError;

/// Artifacts kept beyond each window's current one.
const RETAINED: usize = 32;

pub(crate) struct Artifact {
    pub(crate) revision: String,
    pub(crate) json: Bytes,
    pub(crate) gzip: Bytes,
    pub(crate) generated_at: f64,
}

#[derive(Default)]
struct State {
    artifacts: IndexMap<String, Arc<Artifact>>,
    /// window → (revision, hash of the content without `generatedAt`)
    current: HashMap<u32, (String, String)>,
}

#[derive(Default)]
pub(crate) struct Publications {
    state: Mutex<State>,
    /// One publication at a time per window, in request order (the lock is
    /// fair), while different windows encode concurrently.
    windows: Mutex<HashMap<u32, Arc<tokio::sync::Mutex<()>>>>,
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

impl Publications {
    pub(crate) async fn publish(&self, result: LeaderboardResponse) -> Result<Arc<Artifact>, SourceError> {
        let (days, generated_at) = (result.days, result.generated_at);
        let window = self.windows.lock().entry(days).or_default().clone();
        let _turn = window.lock().await;
        let (content_hash, json) = tokio::task::spawn_blocking(move || -> Result<_, SourceError> {
            let mut content = serde_json::to_value(&result)?;
            if let Some(m) = content.as_object_mut() {
                m.remove("generatedAt");
            }
            let content_hash = sha256_hex(content.to_string().as_bytes());
            Ok((content_hash, serde_json::to_vec(&result)?))
        })
        .await??;
        {
            let state = self.state.lock();
            if let Some((revision, hash)) = state.current.get(&days) {
                if *hash == content_hash {
                    if let Some(existing) = state.artifacts.get(revision) {
                        return Ok(existing.clone());
                    }
                }
            }
        }
        let revision = sha256_hex(&json);
        let existing = self.state.lock().artifacts.get(&revision).cloned();
        let artifact = match existing {
            Some(a) => a,
            None => {
                let revision = revision.clone();
                tokio::task::spawn_blocking(move || -> Result<_, SourceError> {
                    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
                    e.write_all(&json)?;
                    Ok(Arc::new(Artifact { revision, gzip: e.finish()?.into(), json: json.into(), generated_at }))
                })
                .await??
            }
        };
        let mut state = self.state.lock();
        state.artifacts.insert(revision.clone(), artifact.clone());
        state.current.insert(days, (revision, content_hash));
        let current: Vec<String> = state.current.values().map(|(r, _)| r.clone()).collect();
        let mut i = 0;
        while state.artifacts.len() > RETAINED && i < state.artifacts.len() {
            if current.contains(state.artifacts.get_index(i).expect("in range").0) {
                i += 1;
            } else {
                state.artifacts.shift_remove_index(i);
            }
        }
        Ok(artifact)
    }

    pub(crate) fn get(&self, revision: &str) -> Option<Arc<Artifact>> {
        self.state.lock().artifacts.get(revision).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn result(days: u32, total_fills: u64, generated_at: f64) -> LeaderboardResponse {
        let groups = ["protocol", "pool", "to", "category"].iter().map(|g| (g.to_string(), BTreeMap::new())).collect();
        LeaderboardResponse { days, generated_at, total_fills, groups, top_swaps: BTreeMap::new(), outliers: vec![] }
    }

    #[tokio::test]
    async fn reuses_the_artifact_of_unchanged_content_and_keeps_old_revisions() {
        let p = Publications::default();
        let old = p.publish(result(1, 1, 100.0)).await.unwrap();
        let corrected = p.publish(result(1, 2, 101.0)).await.unwrap();
        assert_ne!(old.revision, corrected.revision);
        let unchanged = p.publish(result(1, 2, 102.0)).await.unwrap();
        assert!(Arc::ptr_eq(&unchanged, &corrected), "same content, same artifact and timestamp");
        assert_eq!(unchanged.generated_at, 101.0);
        assert!(p.get(&old.revision).is_some(), "an older revision stays fetchable");
        assert_eq!(old.revision.len(), 64);
        let week = p.publish(result(7, 2, 100.0)).await.unwrap();
        assert_ne!(week.revision, corrected.revision);
        let mut text = String::new();
        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&week.gzip[..]), &mut text).unwrap();
        assert_eq!(text.as_bytes(), &week.json[..]);
    }

    #[tokio::test]
    async fn retention_never_evicts_a_current_window() {
        let p = Publications::default();
        let week = p.publish(result(7, 0, 1.0)).await.unwrap();
        let month = p.publish(result(30, 0, 1.0)).await.unwrap();
        let mut day = Vec::new();
        for n in 0..(RETAINED as u64 + 10) {
            day.push(p.publish(result(1, n, 1.0)).await.unwrap());
        }
        assert!(p.get(&week.revision).is_some() && p.get(&month.revision).is_some());
        assert!(p.get(&day.last().unwrap().revision).is_some());
        assert!(p.get(&day[0].revision).is_none(), "the oldest superseded artifact went");
        assert_eq!(p.state.lock().artifacts.len(), RETAINED);
    }
}
