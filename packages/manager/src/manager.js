/**
 * @integra/manager - manager.js
 * Core PM2 integration. Connects, dispatches, disconnects.
 */

import pm2            from "pm2";
import { resolve }    from "path";
import { logger }     from "./logger.js";
import { buildIntegrationDescriptor,
         buildTrafficControllerDescriptor,
         readIntegrationManifest,
         resolveLifecycle }           from "./descriptor.js";
import { loadRegistry, setEnabled }   from "./registry.js";

// ── PM2 helpers ───────────────────────────────────────────────────────────────

function pm2Connect() {
  return new Promise((res, rej) =>
    pm2.connect(err => err ? rej(err) : res())
  );
}

function pm2Disconnect() {
  pm2.disconnect();
}

function pm2Save() {
  return new Promise((res) =>
    pm2.dump(err => {
      if (err) logger.warn("pm2.save.failed", { message: err.message });
      else     logger.info("pm2.saved");
      res();
    })
  );
}

async function pm2StartOne(descriptor) {
  return new Promise((res, rej) =>
    pm2.start(descriptor, err => err ? rej(err) : res())
  );
}

function pm2StopOne(name) {
  return new Promise(res =>
    pm2.stop(name, err => {
      if (err) logger.debug("pm2.stop.skipped", { name, message: err.message });
      else     logger.info("pm2.stopped", { name });
      res(); // never reject — process may legitimately not exist
    })
  );
}

function pm2RestartOne(name) {
  return new Promise((res, rej) =>
    pm2.restart(name, err => {
      if (err) { logger.error("pm2.restart.failed", { name, message: err.message }); rej(err); }
      else     { logger.info("pm2.restarted", { name }); res(); }
    })
  );
}

function pm2DeleteOne(name) {
  return new Promise(res =>
    pm2.delete(name, err => {
      if (err) logger.debug("pm2.delete.skipped", { name, message: err.message });
      res();
    })
  );
}

// ── Lifecycle resolution ──────────────────────────────────────────────────────

/**
 * Reads the manifest for a registry entry and returns its effective lifecycle.
 */
async function getLifecycle(entry, cwd) {
  const integrationPath = resolve(cwd, entry.path);
  const manifest        = await readIntegrationManifest(integrationPath);
  return resolveLifecycle(entry, manifest);
}

/**
 * Returns all PM2 process names that belong to an integration.
 * Scheduled integrations own their own process + a TC process.
 * Listener and run-once integrations own just their own process.
 */
async function pm2NamesFor(entry, cwd) {
  const lifecycle = await getLifecycle(entry, cwd);
  const names     = [entry.id];
  if (lifecycle === "scheduled") names.push(`${entry.id}--tc`);
  return names;
}

// ── Commands ──────────────────────────────────────────────────────────────────

export async function startAll(cwd = process.cwd()) {
  const integrations = await loadRegistry(cwd);
  const enabled      = integrations.filter(i => i.enabled !== false);

  if (!enabled.length) {
    console.log("No enabled integrations found in registry.");
    return;
  }

  await pm2Connect();

  for (const integration of enabled) {
    const lifecycle = await getLifecycle(integration, cwd);

    try {
      if (lifecycle === "scheduled") {
        // Scheduled: register TC only. TC will start the integration on first cron tick.
        const tcDescriptor = buildTrafficControllerDescriptor(integration, cwd);
        await pm2StartOne(tcDescriptor);
        logger.info("tc.registered", { id: integration.id, schedule: integration.schedule });

      } else if (lifecycle === "listener") {
        // Listener: start directly with autorestart:true — it must stay alive.
        const descriptor = buildIntegrationDescriptor(integration, cwd, "listener");
        await pm2StartOne(descriptor);
        logger.info("integration.started", { id: integration.id, lifecycle: "listener" });

      } else {
        // Run-once: start directly. Exits after one run.
        const descriptor = buildIntegrationDescriptor(integration, cwd, "run-once");
        await pm2StartOne(descriptor);
        logger.info("integration.started", { id: integration.id, lifecycle: "run-once" });
      }
    } catch (err) {
      logger.error("integration.start.failed", { id: integration.id, message: err.message });
    }
  }

  await pm2Save();
  pm2Disconnect();
}

export async function stopOne(id, cwd = process.cwd()) {
  const integrations = await loadRegistry(cwd);
  const entry        = integrations.find(i => i.id === id);
  if (!entry) throw new Error(`Integration not found in registry: ${id}`);

  const names = await pm2NamesFor(entry, cwd);

  await pm2Connect();
  for (const name of names) await pm2StopOne(name);
  await pm2Save();
  pm2Disconnect();
}

export async function restartOne(id, cwd = process.cwd()) {
  const integrations = await loadRegistry(cwd);
  const entry        = integrations.find(i => i.id === id);
  if (!entry) throw new Error(`Integration not found in registry: ${id}`);

  const lifecycle = await getLifecycle(entry, cwd);

  await pm2Connect();

  if (lifecycle === "scheduled") {
    // Restarting the TC is enough — it will re-evaluate and restart the integration
    await pm2RestartOne(`${id}--tc`);
  } else {
    // Listener and run-once: restart the integration process directly
    await pm2RestartOne(id);
  }

  pm2Disconnect();
}

export async function statusAll(cwd = process.cwd()) {
  const integrations = await loadRegistry(cwd);
  const ids          = new Set(integrations.map(i => i.id));

  await pm2Connect();

  const list = await new Promise((res, rej) =>
    pm2.list((err, procs) => err ? rej(err) : res(procs))
  );

  pm2Disconnect();

  // Build lookup maps for TC and lifecycle annotation
  const tcMap = Object.fromEntries(
    list
      .filter(p => p.name.endsWith("--tc"))
      .map(p => [p.name.replace(/--tc$/, ""), p.pm2_env?.status ?? "-"])
  );

  // Read lifecycle for each known integration
  const lifecycleMap = {};
  for (const integration of integrations) {
    lifecycleMap[integration.id] = await getLifecycle(integration, cwd);
  }

  const rows = list
    .filter(p => ids.has(p.name))
    .map(p => ({
      id:        p.name,
      lifecycle: lifecycleMap[p.name] ?? "-",
      status:    p.pm2_env.status,
      pid:       p.pid ?? "-",
      restarts:  p.pm2_env.restart_time,
      uptime:    p.pm2_env.status === "online"
                   ? formatUptime(Date.now() - p.pm2_env.pm_uptime)
                   : "-",
      memory:    p.monit?.memory
                   ? `${Math.round(p.monit.memory / 1024 / 1024)}MB`
                   : "-",
      tc:        tcMap[p.name] ?? "-",
    }));

  return rows;
}

export async function enableIntegration(id, cwd = process.cwd()) {
  await setEnabled(id, true, cwd);
  logger.info("integration.enabled", { id });
}

export async function disableIntegration(id, cwd = process.cwd()) {
  // Stop running processes first, then mark disabled
  await stopOne(id, cwd).catch(() => {}); // best effort
  await setEnabled(id, false, cwd);
  logger.info("integration.disabled", { id });
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `${d}d ${h % 24}h`;
  if (h > 0)  return `${h}h ${m % 60}m`;
  if (m > 0)  return `${m}m ${s % 60}s`;
  return `${s}s`;
}
