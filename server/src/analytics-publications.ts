import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { LeaderboardResponse } from '@shared';

const zip = promisify(gzip);
export interface AnalyticsArtifact { revision: string; json: string; gzip: Buffer; generatedAt: number }

/** Content-addressed results never change in place. A corrected markout gets
 * a new revision; bounded retention cannot evict the current window manifests. */
export class AnalyticsPublications {
  private artifacts = new Map<string, AnalyticsArtifact>();
  private current = new Map<number, { revision: string; contentHash: string }>();
  private pending = new Map<string, Promise<AnalyticsArtifact>>();
  private byResult = new WeakMap<LeaderboardResponse, AnalyticsArtifact>();

  async publish(result: LeaderboardResponse): Promise<AnalyticsArtifact> {
    const cached = this.byResult.get(result);
    if (cached && this.artifacts.has(cached.revision)) return cached;
    // Recomputing unchanged data must not force another download. Reuse the
    // original artifact, including its timestamp, so its URL stays immutable.
    const { generatedAt: _, ...data } = result;
    const contentHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const current = this.current.get(result.days);
    if (current?.contentHash === contentHash) {
      const existing = this.artifacts.get(current.revision);
      if (existing) { this.byResult.set(result, existing); return existing; }
    }
    const inFlight = this.pending.get(contentHash);
    if (inFlight) {
      const artifact = await inFlight;
      this.byResult.set(result, artifact);
      return artifact;
    }
    const json = JSON.stringify(result);
    const revision = createHash('sha256').update(json).digest('hex');
    const work = (async () => {
      const artifact = this.artifacts.get(revision) ?? { revision, json, gzip: await zip(json, { level: 6 }), generatedAt: result.generatedAt };
      this.artifacts.set(revision, artifact);
      this.byResult.set(result, artifact);
      this.current.set(result.days, { revision, contentHash });
      for (const key of this.artifacts.keys()) {
        if (this.artifacts.size <= 32) break;
        if (![...this.current.values()].some((entry) => entry.revision === key)) this.artifacts.delete(key);
      }
      return artifact;
    })().finally(() => this.pending.delete(contentHash));
    this.pending.set(contentHash, work);
    return work;
  }

  get(revision: string): AnalyticsArtifact | undefined { return this.artifacts.get(revision); }
}
