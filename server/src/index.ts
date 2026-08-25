import { config } from './config.js';
import { startServer } from './server.js';
import { SimDataSource } from './datasource/sim.js';
import { LiveDataSource } from './datasource/live.js';
import type { DataSource } from './datasource/index.js';

async function main(): Promise<void> {
  // Live (real chain + CEX references) by default; the simulator is an explicit opt-in.
  // A live boot failure is fatal — we never silently serve simulated data in
  // production. A process supervisor should restart the service.
  const source: DataSource = config.source === 'sim' ? new SimDataSource() : new LiveDataSource();

  // Bind the port up front so a dev proxy / client can connect immediately —
  // endpoints serve empty snapshots during the (multi-second) live warm-up, then
  // the WS stream + snapshot refetch fill them in. (No connect-refused window.)
  const server = startServer(source);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[mpamm] shutting down');
    const forceExit = setTimeout(() => process.exit(0), 5000);
    try { await source.stop(); }
    catch (error) { console.error(`[mpamm] shutdown flush failed: ${(error as Error).message}`); }
    finally { server.close(() => { clearTimeout(forceExit); process.exit(0); }); }
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  console.log(`[mpamm] warming up ${source.mode} source…`);
  await source.start();
  console.log(`[mpamm] ${source.mode} source ready`);
}

main().catch((e) => {
  console.error('[mpamm] fatal:', e);
  process.exit(1);
});
