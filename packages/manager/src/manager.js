/**
 * @integra/manager - manager.js
 * Core PM2 integration. Connects, dispatches, disconnects.
 */

import pm2            from "pm2";
import { logger }     from "./logger.js";
import { buildDescriptor } from "./descriptor.js";
import { loadRegistry, saveRegistry, setEnabled } from "./registry.js";

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

export async function startAll(cwd = process.cwd()) {
  const integrations = await loadRegistry(cwd);
  const enabled      = integrations.filter(i => i.enabled !== false);

  if (!enabled.length) {
    console.log("No enabled integrations found in registry.");
    return;
  }

  await pm2Connect();

  for (const integration of enabled) {
    const descriptor = buildDescriptor(integration, cwd);
    await new Promise((res, rej) =>
      pm2.start(descriptor, (err) => {
        if (err) {
          logger.error("integration.start.failed", { id: integration.id, message: err.message });
          rej(err);
        } else {
          logger.info("integration.started", { id: integration.id });
          res();
        }
      })
    );
  }

  await pm2Save();
  pm2Disconnect();
}

export async function stopOne(id, cwd = process.cwd()) {
  await pm2Connect();
  await new Promise((res, rej) =>
    pm2.stop(id, (err) => {
      if (err) { logger.error("integration.stop.failed", { id, message: err.message }); rej(err); }
      else     { logger.info("integration.stopped", { id }); res(); }
    })
  );
  await pm2Save();
  pm2Disconnect();
}

export async function restartOne(id, cwd = process.cwd()) {
  await pm2Connect();
  await new Promise((res, rej) =>
    pm2.restart(id, (err) => {
      if (err) { logger.error("integration.restart.failed", { id, message: err.message }); rej(err); }
      else     { logger.info("integration.restarted", { id }); res(); }
    })
  );
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

  const rows = list
    .filter(p => ids.has(p.name))
    .map(p => ({
      id:          p.name,
      status:      p.pm2_env.status,
      pid:         p.pid ?? "-",
      restarts:    p.pm2_env.restart_time,
      uptime:      p.pm2_env.status === "online"
                     ? formatUptime(Date.now() - p.pm2_env.pm_uptime)
                     : "-",
      memory:      p.monit?.memory
                     ? `${Math.round(p.monit.memory / 1024 / 1024)}MB`
                     : "-",
    }));

  return rows;
}

export async function enableIntegration(id, cwd = process.cwd()) {
  await setEnabled(id, true, cwd);
  logger.info("integration.enabled", { id });
}

export async function disableIntegration(id, cwd = process.cwd()) {
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
