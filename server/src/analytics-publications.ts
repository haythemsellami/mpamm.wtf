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
  private current = new Map<number, string>();
  private pending = new Map<string, Promise<AnalyticsArtifact>>();
  private byResult = new WeakMap<LeaderboardResponse, AnalyticsArtifact>();

  async publish(result: LeaderboardResponse): Promise<AnalyticsArtifact> {
    const cached = this.byResult.get(result);
    if (cached && this.artifacts.has(cached.revision)) return cached;
    const json = JSON.stringify(result);
    const revision = createHash('sha256').update(json).digest('hex');
    const existing = this.artifacts.get(revision);
    if (existing) return existing;
    const inFlight = this.pending.get(revision);
    if (inFlight) return inFlight;
    const work = (async () => {
      const artifact = { revision, json, gzip: await zip(json, { level: 6 }), generatedAt: result.generatedAt };
      this.artifacts.set(revision, artifact);
      this.byResult.set(result, artifact);
      this.current.set(result.days, revision);
      for (const key of this.artifacts.keys()) {
        if (this.artifacts.size <= 32) break;
        if (![...this.current.values()].includes(key)) this.artifacts.delete(key);
      }
      return artifact;
    })().finally(() => this.pending.delete(revision));
    this.pending.set(revision, work);
    return work;
  }

  get(revision: string): AnalyticsArtifact | undefined { return this.artifacts.get(revision); }
}
