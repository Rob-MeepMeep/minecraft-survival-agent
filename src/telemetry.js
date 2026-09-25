'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

/**
 * Creates a JSONL telemetry writer.
 *
 * Events are written to `logs/<runId>.jsonl` and printed to stdout as
 * human-readable summaries. Repetitive errors with the same errorCode
 * are rate-limited to one log line per 5 seconds.
 *
 * @param {string} runId  Unique identifier for this run.
 * @returns {{ emit(event: object): void, close(): void }}
 */
function createTelemetry(runId) {
  const logsDir = path.resolve('logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const filePath = path.join(logsDir, `${runId}.jsonl`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });

  /** @type {Map<string, number>} errorCode → last-emitted timestamp */
  const errorThrottle = new Map();
  const THROTTLE_MS = 5000;

  let closed = false;

  function emit(event) {
    if (closed || stream.writableEnded || !stream.writable) return;

    const record = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Rate-limit repetitive errors.
    if (record.errorCode) {
      const last = errorThrottle.get(record.errorCode) || 0;
      const now = Date.now();
      if (now - last < THROTTLE_MS) return;
      errorThrottle.set(record.errorCode, now);
    }

    // Write JSONL line.
    try {
      stream.write(JSON.stringify(record) + '\n');
    } catch {
      // Guard against stream errors during abrupt shutdown
    }

    // Human-readable console summary.
    const ts = record.timestamp.slice(11, 23); // HH:MM:SS.mmm
    const tag = record.event || 'info';
    const detail = formatDetail(record);
    console.log(`[${ts}] ${tag}${detail ? '  ' + detail : ''}`);
  }

  let streamError = null;
  stream.on('error', (err) => {
    streamError = err;
  });

  async function close() {
    if (closed) return;
    closed = true;
    return new Promise((resolve, reject) => {
      stream.end(() => {
        if (streamError) reject(streamError);
        else resolve();
      });
    });
  }

  return { emit, close, getFilePath: () => filePath, getError: () => streamError };
}

/**
 * Produces a compact human-readable detail string from a telemetry record.
 */
function formatDetail(record) {
  switch (record.event) {
    case 'startup':
      return `node=${record.nodeVersion} mineflayer=${record.mineflayerVersion} platform=${record.platform}`;
    case 'config':
      return `host=${record.config?.host}:${record.config?.port} user=${record.config?.username} auth=${record.config?.auth} version=${record.config?.version}`;
    case 'login':
      return `mc=${record.mcVersion} protocol=${record.protocolVersion} requested=${record.requestedVersion}`;
    case 'spawn': {
      const readyTag = record.ready === false ? ' [NOT READY]' : '';
      return `pos=(${record.position?.x}, ${record.position?.y}, ${record.position?.z}) dim=${record.dimension} session=${record.sessionId}${readyTag}`;
    }
    case 'snapshot':
      return `hp=${record.state?.health} food=${record.state?.food} pos=(${record.state?.position?.x}, ${record.state?.position?.y}, ${record.state?.position?.z})`;
    case 'vital_change':
      return `hp=${record.health} (${record.healthDelta >= 0 ? '+' : ''}${record.healthDelta}) food=${record.food} (${record.foodDelta >= 0 ? '+' : ''}${record.foodDelta})`;
    case 'damage_received':
      return `hp=${record.health} source=${record.source}`;
    case 'inventory_change':
      return `trigger=${record.trigger} items=[${record.items?.map(i => `${i.name}:${i.count}`).join(', ')}]`;
    case 'death':
      return `Bot died; awaiting respawn. session=${record.sessionId}`;
    case 'end':
      return `${record.reason || 'Disconnected.'} session=${record.sessionId}`;
    case 'kicked':
      return `reason=${JSON.stringify(record.reason)}`;
    case 'error':
      return record.message || '';
    case 'command':
      return record.command || '';
    case 'pause':
      return `Paused. (was=${record.wasPaused})`;
    case 'resume':
      return `Resumed. (was=${record.wasPaused})`;
    case 'action_start': {
      if (record.action === 'gather') {
        const drops = record.target?.expectedDrops ? ` expected=[${record.target.expectedDrops.join(', ')}]` : '';
        return `[${record.actionId}] action=gather block=${record.target?.block || 'unknown'} pos=(${record.target?.x}, ${record.target?.y}, ${record.target?.z})${drops} timeout=${Math.round((record.timeoutMs || 0) / 1000)}s`;
      }
      if (record.action === 'craft') {
        const tableTag = record.target?.requiresTable ? ' [requires crafting_table]' : ' [2x2 grid]';
        return `[${record.actionId}] action=craft item=${record.target?.item || 'unknown'} times=${record.target?.times || 1}${tableTag} timeout=${Math.round((record.timeoutMs || 0) / 1000)}s`;
      }
      if (record.action === 'equip') {
        return `[${record.actionId}] action=equip item=${record.target?.item} destination=${record.target?.destination || 'hand'}`;
      }
      if (record.action === 'unequip') {
        return `[${record.actionId}] action=unequip destination=${record.target?.destination || 'hand'}`;
      }
      if (record.action === 'eat') {
        const itemTag = record.target?.requestedItem || 'auto';
        const unsafeTag = record.target?.allowUnsafe ? ' [allow_unsafe]' : '';
        return `[${record.actionId}] action=eat item=${itemTag}${unsafeTag} timeout=${Math.round((record.timeoutMs || 0) / 1000)}s`;
      }
      if (record.action === 'place') {
        return `[${record.actionId}] action=place block=${record.target?.block || 'unknown'} pos=(${record.target?.x}, ${record.target?.y}, ${record.target?.z}) timeout=${Math.round((record.timeoutMs || 0) / 1000)}s`;
      }
      if (record.action === 'attack') {
        const targetType = record.target?.entityTypeOrId || record.target?.animalType || 'animal';
        const entityTag = record.target?.entityId !== undefined ? ` entityId=${record.target.entityId}` : '';
        return `[${record.actionId}] action=attack target=${targetType}${entityTag} timeout=${Math.round((record.timeoutMs || 0) / 1000)}s`;
      }
      const reqRange = record.target?.requestedRange ?? record.target?.range;
      const tol = record.target?.arrivalTolerance ?? 0.5;
      return `[${record.actionId}] action=${record.action} target=(${record.target?.x}, ${record.target?.y}, ${record.target?.z}) requestedRange=${reqRange} arrivalTolerance=${tol} timeout=${Math.round((record.timeoutMs || 0) / 1000)}s`;
    }
    case 'action_end': {
      if (record.action === 'gather') {
        const matched = record.matchedAcquisitions && record.matchedAcquisitions.length > 0
          ? record.matchedAcquisitions.map(i => `${i.name}:+${i.delta}`).join(', ')
          : (record.acquiredItems ? record.acquiredItems.map(i => `${i.name}:+${i.delta}`).join(', ') : 'none');
        const unrelated = record.unrelatedAcquisitions && record.unrelatedAcquisitions.length > 0
          ? ` unrelated=[${record.unrelatedAcquisitions.map(i => `${i.name}:+${i.delta}`).join(', ')}]`
          : '';
        const blockState = record.finalBlockState ? ` finalBlock=${record.finalBlockState}` : '';
        const entityTag = record.trackedEntityId !== undefined && record.trackedEntityId !== null ? ` entityId=${record.trackedEntityId}` : '';
        return `[${record.actionId}] action=gather outcome=${record.outcome} reason=${record.reason} duration=${record.durationMs}ms matched=[${matched}]${unrelated}${blockState}${entityTag} finalPos=(${record.finalPos?.x}, ${record.finalPos?.y}, ${record.finalPos?.z})`;
      }
      if (record.action === 'craft') {
        const consumedStr = record.consumed && record.consumed.length > 0
          ? record.consumed.map(c => `${c.name}:${c.count}`).join(', ')
          : 'none';
        const yieldStr = record.yield !== undefined ? ` yield=${record.item}:+${record.yield}` : '';
        return `[${record.actionId}] action=craft outcome=${record.outcome} reason=${record.reason} duration=${record.durationMs}ms${yieldStr} consumed=[${consumedStr}]`;
      }
      if (record.action === 'equip') {
        return `[${record.actionId}] action=equip outcome=${record.outcome} reason=${record.reason} item=${record.item} dest=${record.destination} slot=${record.destSlot}`;
      }
      if (record.action === 'unequip') {
        return `[${record.actionId}] action=unequip outcome=${record.outcome} reason=${record.reason} dest=${record.destination} slot=${record.destSlot}`;
      }
      if (record.action === 'eat') {
        const foodStr = record.foodDelta !== undefined
          ? ` food=${record.foodBefore}->${record.foodAfter}(${record.foodDelta >= 0 ? '+' : ''}${record.foodDelta})`
          : '';
        const satStr = record.satDelta !== undefined
          ? ` sat=${record.satBefore}->${record.satAfter}(${record.satDelta >= 0 ? '+' : ''}${record.satDelta})`
          : '';
        return `[${record.actionId}] action=eat outcome=${record.outcome} reason=${record.reason} item=${record.item || record.requestedItem || 'unknown'} consumed=${record.itemsConsumed || 0}${foodStr}${satStr} duration=${record.durationMs}ms`;
      }
      if (record.action === 'place') {
        const blockTag = record.block || record.details?.block || record.targetPos?.block || 'unknown';
        const posTag = record.targetPos ? ` pos=(${record.targetPos.x}, ${record.targetPos.y}, ${record.targetPos.z})` : '';
        const consumed = record.itemsConsumed !== undefined ? record.itemsConsumed : (record.details?.itemsConsumed !== undefined ? record.details.itemsConsumed : 0);
        return `[${record.actionId}] action=place outcome=${record.outcome} reason=${record.reason} block=${blockTag}${posTag} consumed=${consumed} duration=${record.durationMs}ms`;
      }
      if (record.action === 'attack') {
        const hits = record.hitAttempted !== undefined ? record.hitAttempted : (record.details?.hitAttempted ?? 0);
        const dmg = record.damageConfirmed !== undefined ? record.damageConfirmed : Boolean(record.details?.damageConfirmed);
        const death = record.deathConfirmed !== undefined ? record.deathConfirmed : Boolean(record.details?.deathConfirmed || record.details?.killed);
        const method = record.attributionMethod || record.details?.attributionMethod || 'none';
        const loot = record.matchedLoot || record.details?.matchedLoot || [];
        const lootStr = loot.length > 0 ? loot.map(l => `${l.name}:+${l.delta}`).join(', ') : 'none';
        return `[${record.actionId}] action=attack outcome=${record.outcome} reason=${record.reason} hitsAttempted=${hits} damageConfirmed=${dmg} deathConfirmed=${death} attributionMethod=${method} matchedLoot=[${lootStr}] duration=${record.durationMs}ms`;
      }
      const reqRange = record.requestedRange ?? record.targetPos?.requestedRange ?? record.targetPos?.range;
      const tol = record.arrivalTolerance ?? record.targetPos?.arrivalTolerance ?? 0.5;
      const maxDist = record.maxAcceptableDistance ?? record.targetPos?.maxAcceptableDistance;
      const distInfo = record.distanceToTarget !== undefined
        ? `dist=${record.distanceToTarget} (requestedRange=${reqRange} tol=${tol}${maxDist !== undefined ? ` max=${maxDist}` : ''})`
        : 'dist=n/a';
      return `[${record.actionId}] action=${record.action} outcome=${record.outcome} reason=${record.reason} duration=${record.durationMs}ms finalPos=(${record.finalPos?.x}, ${record.finalPos?.y}, ${record.finalPos?.z}) ${distInfo}`;
    }
    case 'controller_start':
      return `[${record.controllerRunId}] goal=${record.goal} dryRun=${record.dryRun} gen=${record.generation}`;
    case 'controller_intent': {
      const simTag = record.simulated ? ' [SIMULATED]' : '';
      if (record.action) {
        return `[${record.controllerRunId}]${simTag} step=${record.step || 1} action=${record.action} reason=${record.reason} args=${JSON.stringify(record.args)}`;
      }
      return `[${record.controllerRunId}]${simTag} status=${record.status} reason=${record.reason || 'ok'} ${record.message || ''}`;
    }
    case 'controller_preemption':
      return `[${record.controllerRunId}] PREEMPTION reason=${record.reason}`;
    case 'controller_goal_suspended':
      return `[${record.controllerRunId}] GOAL SUSPENDED goal=${record.goal} trigger=${record.trigger} newGoal=${record.newGoal}`;
    case 'controller_goal_resumed':
      return `[${record.controllerRunId}] GOAL RESUMED goal=${record.goal} predicate=${JSON.stringify(record.predicate)}`;
    case 'controller_goal_completed':
      return `[${record.controllerRunId}] GOAL COMPLETED goal=${record.goal} actions=${record.dispatchedActions}`;
    case 'controller_stop':
      return `[${record.controllerRunId}] stopped reason=${record.reason} status=${record.status}`;
    case 'shutdown':
      return `reason=${record.reason} duration=${record.summary?.durationFormatted} spawns=${record.summary?.spawns} deaths=${record.summary?.deaths}`;
    default:
      return '';
  }
}


module.exports = { createTelemetry };
