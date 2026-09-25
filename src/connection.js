'use strict';

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { snapshot, round1 } = require('./observer');

/**
 * Creates a mineflayer bot, loads plugins, wires lifecycle events,
 * and returns control handles.
 *
 * @param {object} config        Frozen config from config.js.
 * @param {object} telemetry     Telemetry instance from telemetry.js.
 * @returns {{ bot: import('mineflayer').Bot, shutdown: () => void }}
 */
function createAgent(config, telemetry) {
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version,
    profilesFolder: config.profilesFolder,
  });

  // Load pathfinder plugin (used later in Stage 2+, cheap to load now).
  bot.loadPlugin(pathfinder);

  let active = false;
  let ready = false;
  let sessionId = 0;

  // --- Periodic snapshot timer ---
  let snapshotInterval = null;

  function startSnapshots() {
    stopSnapshots();
    snapshotInterval = setInterval(() => {
      if (!active) return;
      try {
        const snap = snapshot(bot);
        telemetry.emit({ event: 'snapshot', state: snap });
      } catch (err) {
        telemetry.emit({
          event: 'error',
          errorCode: 'SNAPSHOT_FAILED',
          message: err.message,
        });
      }
    }, 10_000);
    // Allow the process to exit even if the interval is running.
    if (snapshotInterval.unref) snapshotInterval.unref();
  }

  function stopSnapshots() {
    if (snapshotInterval) {
      clearInterval(snapshotInterval);
      snapshotInterval = null;
    }
  }

  // --- Negotiated version (Fix 1) ---

  bot.once('login', () => {
    const mcVersion = bot.version || 'unknown';
    const protocolVersion = bot.protocolVersion || 'unknown';
    telemetry.emit({
      event: 'login',
      mcVersion,
      protocolVersion,
      requestedVersion: config.version || '(auto-detect)',
    });
  });

  // --- Lifecycle events ---

  bot.on('spawn', () => {
    active = true;
    ready = false;
    sessionId++;
    const currentSession = sessionId;

    // Health/food may not be populated yet at spawn time.
    // Wait briefly for the server to send them, then emit the spawn event.
    const readyCheck = setInterval(() => {
      // Session changed — this spawn is stale.
      if (currentSession !== sessionId) {
        clearInterval(readyCheck);
        return;
      }
      if (bot.health !== undefined && bot.health !== null) {
        clearInterval(readyCheck);
        ready = true;
        const snap = snapshot(bot);
        telemetry.emit({
          event: 'spawn',
          sessionId: currentSession,
          ready: true,
          position: snap.position,
          dimension: snap.dimension,
          health: snap.health,
          food: snap.food,
          saturation: snap.saturation,
          inventory: snap.inventory,
          gameTime: snap.gameTime,
          isNight: snap.isNight,
        });
        startSnapshots();
      }
    }, 100);
    readyCheck.unref?.();

    // Safety timeout — emit spawn even if health never arrives.
    const readyTimeout = setTimeout(() => {
      if (currentSession !== sessionId || ready) return;
      clearInterval(readyCheck);
      ready = true;
      const snap = snapshot(bot);
      telemetry.emit({
        event: 'spawn',
        sessionId: currentSession,
        ready: false,
        note: 'Health was not populated within 2 seconds of spawn.',
        position: snap.position,
        dimension: snap.dimension,
        health: snap.health,
        food: snap.food,
        saturation: snap.saturation,
        inventory: snap.inventory,
        gameTime: snap.gameTime,
        isNight: snap.isNight,
      });
      startSnapshots();
    }, 2000);
    readyTimeout.unref?.();
  });

  bot.on('death', () => {
    active = false;
    ready = false;
    stopSnapshots();
    try {
      if (bot.pathfinder) {
        bot.pathfinder.stop();
        bot.pathfinder.setGoal(null);
      }
    } catch { /* may not be initialized */ }
    try { bot.clearControlStates(); } catch { /* ok */ }
    telemetry.emit({ event: 'death', sessionId });
  });

  bot.on('end', (reason) => {
    active = false;
    ready = false;
    stopSnapshots();
    telemetry.emit({ event: 'end', reason: reason || 'disconnected', sessionId });
  });

  bot.on('kicked', (reason) => {
    telemetry.emit({ event: 'kicked', reason, sessionId });
  });

  bot.on('error', (error) => {
    telemetry.emit({
      event: 'error',
      errorCode: 'CONNECTION_ERROR',
      message: error.message,
    });
  });

  // --- Real-time change tracking (Fix 3) ---

  let lastHealth = null;
  let lastFood = null;

  bot.on('health', () => {
    const hp = bot.health;
    const food = bot.food;
    const sat = bot.foodSaturation;

    const healthChanged = lastHealth !== null && hp !== lastHealth;
    const foodChanged = lastFood !== null && food !== lastFood;

    if (healthChanged || foodChanged) {
      telemetry.emit({
        event: 'vital_change',
        sessionId,
        health: hp,
        healthDelta: lastHealth !== null ? round1(hp - lastHealth) : null,
        food,
        foodDelta: lastFood !== null ? food - lastFood : null,
        saturation: sat,
        source: 'unknown',
      });
    }

    lastHealth = hp;
    lastFood = food;
  });

  // Track damage from known entities.
  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity) {
      telemetry.emit({
        event: 'damage_received',
        sessionId,
        health: bot.health,
        source: 'unknown',
      });
    }
  });

  // Track inventory changes.
  let lastInventoryHash = '';

  function inventoryHash() {
    if (!bot.inventory) return '';
    return bot.inventory.items()
      .map(i => `${i.name}:${i.count}`)
      .sort()
      .join(',');
  }

  function checkInventoryChange(trigger) {
    const newHash = inventoryHash();
    if (newHash !== lastInventoryHash) {
      const items = bot.inventory
        ? bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
        : [];
      telemetry.emit({
        event: 'inventory_change',
        sessionId,
        trigger,
        items,
      });
      lastInventoryHash = newHash;
    }
  }

  bot.inventory?.on('updateSlot', () => checkInventoryChange('slot_update'));
  bot.on('playerCollect', () => {
    // Delay slightly so inventory reflects the pickup.
    setTimeout(() => checkInventoryChange('player_collect'), 100);
  });

  // --- Shutdown ---

  function shutdown() {
    active = false;
    ready = false;
    stopSnapshots();
    try {
      if (bot.pathfinder) {
        bot.pathfinder.stop();
        bot.pathfinder.setGoal(null);
      }
    } catch { /* ok */ }
    try { bot.clearControlStates(); } catch { /* ok */ }
    try { bot.quit(); } catch { /* ok */ }
  }

  return {
    bot,
    shutdown,
    /** Whether the bot is currently spawned and active. */
    get active() { return active; },
    /** Whether health/food have been received since last spawn. */
    get ready() { return ready; },
    /** Current session counter; increments on each spawn. */
    get sessionId() { return sessionId; },
  };
}

module.exports = { createAgent };
