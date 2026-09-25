'use strict';

const { Movements, goals } = require('mineflayer-pathfinder');
const { round1 } = require('../observer');

/** Margin allowed around target bounding box / center offset. */
const DEFAULT_ARRIVAL_TOLERANCE = 0.5;

/**
 * Creates configured Movements ensuring safe navigation without world modification:
 * - canDig = false (no block breaking)
 * - scafoldingBlocks = [] (no block placement)
 * - allow1by1towers = false (no jumping towers)
 */
function createSafeMovements(bot) {
  try {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.scafoldingBlocks = [];
    movements.allow1by1towers = false;
    return movements;
  } catch {
    return { canDig: false, scafoldingBlocks: [], allow1by1towers: false };
  }
}

/**
 * Parses user terminal command arguments for navigation.
 * Formats supported:
 *   goto <x> <y> <z> [range] [timeoutSec]
 *   goto ~<dx> ~<dy> ~<dz> [range] [timeoutSec]
 *   goto <x> <z> [range] [timeoutSec] (y defaults to current bot y)
 *
 * @param {string[]} args Command arguments
 * @param {{ x: number, y: number, z: number }} currentPos Bot current position
 * @returns {{ ok: true, target: { x: number, y: number, z: number, range: number, requestedRange: number, arrivalTolerance: number, maxAcceptableDistance: number }, timeoutMs: number } | { ok: false, error: string }}
 */
function parseNavigationArgs(args, currentPos) {
  if (!args || args.length === 0) {
    return {
      ok: false,
      error: 'Usage: goto <x> <y> <z> [range=1] [timeoutSec=30] or goto ~<dx> ~<dy> ~<dz>',
    };
  }

  function parseCoord(token, base) {
    if (token.startsWith('~')) {
      const offset = token.slice(1);
      if (offset === '') return base;
      const num = Number(offset);
      return Number.isFinite(num) ? base + num : NaN;
    }
    const num = Number(token);
    return Number.isFinite(num) ? num : NaN;
  }

  let x, y, z;
  let remainingArgs;

  if (args.length >= 3) {
    x = parseCoord(args[0], currentPos?.x ?? 0);
    y = parseCoord(args[1], currentPos?.y ?? 0);
    z = parseCoord(args[2], currentPos?.z ?? 0);
    remainingArgs = args.slice(3);
  } else if (args.length === 2) {
    // 2 coords: assume x and z, keep current y
    x = parseCoord(args[0], currentPos?.x ?? 0);
    y = currentPos?.y ?? 0;
    z = parseCoord(args[1], currentPos?.z ?? 0);
    remainingArgs = args.slice(2);
  } else {
    return {
      ok: false,
      error: 'Invalid coordinates. Must provide at least x and z: goto <x> [y] <z>',
    };
  }

  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
    return {
      ok: false,
      error: `Invalid numeric coordinate values: [${args.slice(0, 3).join(', ')}]`,
    };
  }

  // Optional range (default 1 block)
  let range = 1;
  if (remainingArgs.length > 0) {
    const parsedRange = Number(remainingArgs[0]);
    if (!Number.isFinite(parsedRange) || parsedRange < 0) {
      return { ok: false, error: `Invalid range: "${remainingArgs[0]}"` };
    }
    range = parsedRange;
  }

  // Optional timeout in seconds (default 30s)
  let timeoutMs = 30_000;
  if (remainingArgs.length > 1) {
    const parsedTimeoutSec = Number(remainingArgs[1]);
    if (!Number.isFinite(parsedTimeoutSec) || parsedTimeoutSec <= 0) {
      return { ok: false, error: `Invalid timeout: "${remainingArgs[1]}"` };
    }
    timeoutMs = Math.round(parsedTimeoutSec * 1000);
  }

  const requestedRange = round1(range);
  const arrivalTolerance = DEFAULT_ARRIVAL_TOLERANCE;
  const maxAcceptableDistance = round1(requestedRange + arrivalTolerance);

  return {
    ok: true,
    target: {
      x: round1(x),
      y: round1(y),
      z: round1(z),
      range: requestedRange,
      requestedRange,
      arrivalTolerance,
      maxAcceptableDistance,
    },
    timeoutMs,
  };
}

/**
 * Calculates 3D Euclidean distance between two positions.
 */
function distance3D(p1, p2) {
  if (!p1 || !p2) return Infinity;
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const dz = p1.z - p2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Sets up navigation action primitive on top of ActionManager.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('./manager').ActionManager} actionManager
 */
function createNavigator(bot, actionManager) {
  let movements = null;

  function getMovements() {
    if (!movements) {
      movements = createSafeMovements(bot);
    }
    return movements;
  }

  /**
   * Navigates to target coordinates with timeout and postcondition verification.
   *
   * @param {{ x: number, y: number, z: number, range?: number, requestedRange?: number, arrivalTolerance?: number, maxAcceptableDistance?: number }} target
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<object>} Settled action result
   */
  async function goto(target, timeoutMs = 30_000) {
    const requestedRange = target.requestedRange ?? target.range ?? 1;
    const arrivalTolerance = target.arrivalTolerance ?? DEFAULT_ARRIVAL_TOLERANCE;
    const maxAcceptableDistance = target.maxAcceptableDistance ?? round1(requestedRange + arrivalTolerance);

    return actionManager.run('navigate', target, timeoutMs, async (signal) => {
      bot.pathfinder.setMovements(getMovements());
      const goal = new goals.GoalNear(target.x, target.y, target.z, requestedRange);

      let lastPos = bot.entity?.position ? bot.entity.position.clone() : null;
      let lastMoveTime = Date.now();
      const stuckCheck = setInterval(() => {
        if (signal.aborted) {
          clearInterval(stuckCheck);
          return;
        }
        const curr = bot.entity?.position;
        if (curr && lastPos) {
          const moved = distance3D(curr, lastPos);
          if (moved > 0.5) {
            lastMoveTime = Date.now();
            lastPos = curr.clone();
          } else if (Date.now() - lastMoveTime > 4000) {
            clearInterval(stuckCheck);
            try { bot.pathfinder.stop(); } catch {}
          }
        }
      }, 500);

      try {
        await bot.pathfinder.goto(goal);
      } catch (err) {
        // If aborted externally, actionManager will handle settlement.
        if (signal.aborted) {
          throw err;
        }

        const currPos = bot.entity?.position;
        const dist = round1(distance3D(currPos, target));

        return {
          outcome: 'failed',
          reason: err.message || 'pathfinding_error',
          details: {
            distanceToTarget: dist,
            requestedRange,
            arrivalTolerance,
            maxAcceptableDistance,
          },
        };
      } finally {
        clearInterval(stuckCheck);
      }

      // Postcondition verification: check measured distance against maxAcceptableDistance
      const currPos = bot.entity?.position;
      const finalDist = round1(distance3D(currPos, target));

      if (finalDist <= maxAcceptableDistance) {
        return {
          outcome: 'success',
          reason: 'reached_destination',
          details: {
            distanceToTarget: finalDist,
            requestedRange,
            arrivalTolerance,
            maxAcceptableDistance,
          },
        };
      } else {
        return {
          outcome: 'failed',
          reason: 'destination_distance_exceeded',
          details: {
            distanceToTarget: finalDist,
            requestedRange,
            arrivalTolerance,
            maxAcceptableDistance,
          },
        };
      }
    });
  }

  /**
   * Convenience wrapper accepting individual coordinates or coordinate object.
   */
  async function navigate(x, y, z, range = 1, timeoutMs = 30_000) {
    if (typeof x === 'object' && x !== null) {
      return goto(x, y || timeoutMs);
    }
    return goto({ x, y, z, range }, timeoutMs);
  }

  return {
    goto,
    navigate,
    createSafeMovements,
  };
}

module.exports = {
  createNavigator,
  createSafeMovements,
  parseNavigationArgs,
  distance3D,
  DEFAULT_ARRIVAL_TOLERANCE,
};
