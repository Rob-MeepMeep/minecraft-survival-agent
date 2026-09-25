'use strict';

const { goals } = require('mineflayer-pathfinder');
const { getInventoryCounts, computeInventoryDelta } = require('./gather');

/**
 * Passive food animal entity types.
 * These are the only entities the attacker will target autonomously.
 */
const FOOD_ANIMAL_TYPES = new Set([
  'chicken',
  'cow',
  'pig',
  'sheep',
  'rabbit',
]);

/**
 * Expected loot from each animal type (raw; cooking is a future stage).
 */
const ANIMAL_DROPS = {
  chicken:  ['raw_chicken', 'chicken', 'feather'],
  cow:      ['raw_beef', 'beef', 'leather'],
  pig:      ['raw_porkchop', 'porkchop'],
  sheep:    ['raw_mutton', 'mutton', 'white_wool', 'wool'],
  rabbit:   ['raw_rabbit', 'rabbit', 'rabbit_hide'],
};

/**
 * Checks whether an entity type is a valid food animal.
 *
 * @param {string} entityType
 * @returns {boolean}
 */
function isFoodAnimal(entityType) {
  return FOOD_ANIMAL_TYPES.has(String(entityType).toLowerCase());
}

/**
 * Checks whether an animal entity is an adult, untamed, un-named, un-leashed mob.
 *
 * @param {object} entity
 * @returns {boolean}
 */
function isEligibleAdultAnimal(entity) {
  if (!entity) return false;
  const type = entity.name || entity.type;
  if (!isFoodAnimal(type)) return false;

  // 1. Juvenile / Baby check (version-aware)
  if (entity.isBaby === true) return false;
  if (entity.metadata) {
    const m16 = entity.metadata[16];
    if (typeof m16 === 'boolean' && m16 === true) return false;
    if (typeof m16 === 'number' && m16 < 0) return false;
  }

  // 2. Named entity check (exclude pets, named animals)
  if (entity.customName) return false;
  if (
    entity.displayName &&
    entity.displayName.toLowerCase() !== (entity.name || '').toLowerCase() &&
    entity.displayName.toLowerCase() !== (type || '').toLowerCase()
  ) {
    return false;
  }
  if (entity.metadata && typeof entity.metadata[2] === 'string' && entity.metadata[2].length > 0) {
    return false;
  }

  // 3. Leashed entity check
  if (entity.leashed) return false;
  if (entity.metadata && typeof entity.metadata[17] === 'number' && (entity.metadata[17] & 0x04)) {
    return false;
  }

  return true;
}

function safeDistance(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x ?? 0) - (b.x ?? 0);
  const dy = (a.y ?? 0) - (b.y ?? 0);
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Counts the number of eligible adult animals of a given species within range.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string} animalType
 * @param {number} [maxDistance=24]
 * @returns {number}
 */
function countEligibleAdults(bot, animalType, maxDistance = 24) {
  if (!bot || !bot.entities || !bot.entity?.position) return 0;
  let count = 0;
  for (const e of Object.values(bot.entities)) {
    if (!e || (e.name || e.type) !== animalType) continue;
    if (!isEligibleAdultAnimal(e)) continue;
    if (e.position && safeDistance(bot.entity.position, e.position) <= maxDistance) {
      count++;
    }
  }
  return count;
}

/**
 * Finds the nearest eligible adult food animal entity within range,
 * enforcing population preservation (requires >= 3 adults of species).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string|null} [preferredType=null] - Optional entity type filter
 * @param {number} [maxDistance=16]
 * @returns {{ entity: object, type: string, distance: number }|null}
 */
function findNearestFoodAnimal(bot, preferredType = null, maxDistance = 16) {
  if (!bot || !bot.entities) return null;

  let best = null;
  let bestDist = Infinity;

  for (const entity of Object.values(bot.entities)) {
    const type = entity.name || entity.type;
    if (!isFoodAnimal(type)) continue;
    if (preferredType && type !== preferredType) continue;
    if (!isEligibleAdultAnimal(entity)) continue;

    const pos = entity.position;
    if (!pos || !bot.entity?.position) continue;

    const dx = pos.x - bot.entity.position.x;
    const dy = pos.y - bot.entity.position.y;
    const dz = pos.z - bot.entity.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist <= maxDistance && dist < bestDist) {
      // Check population preservation: need >= 3 adults so at least 2 remain
      const count = countEligibleAdults(bot, type, maxDistance);
      if (count >= 3) {
        best = { entity, type, distance: dist };
        bestDist = dist;
      }
    }
  }

  return best;
}

/**
 * Creates an attack action primitive wired into ActionManager.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('./manager').ActionManager} actionManager
 * @returns {{ attack: function, isFoodAnimal: function, isEligibleAdultAnimal: function, countEligibleAdults: function, findNearestFoodAnimal: function, FOOD_ANIMAL_TYPES: Set, ANIMAL_DROPS: object }}
 */
function createAttacker(bot, actionManager) {
  /**
   * Navigates to a food animal and attacks it in a multi-hit loop until it dies or timeout.
   * Records loot gained as `matchedLoot` with strict item-entity tracking.
   *
   * @param {string|number} entityTypeOrId - Entity type name (e.g. 'cow') or numeric entity ID
   * @param {object} [options]
   * @param {number} [options.timeoutMs=15000] - Max allowed duration for the full attack
   * @param {number} [options.meleeRange=2.5] - Distance to approach before attacking
   * @param {number} [options.maxSearchDistance=16] - Max radius to search for entity
   * @returns {Promise<object>} Settled action result
   */
  async function attack(entityTypeOrId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const meleeRange = options.meleeRange ?? 2.5;
    const maxSearchDistance = options.maxSearchDistance ?? 16;

    return actionManager.run('attack', { entityTypeOrId }, timeoutMs, async (signal, actionId) => {
      let hitAttempted = 0;
      let damageConfirmed = false;
      let deathConfirmed = false;

      // -----------------------------------------------------------------------
      // 1. Resolve target entity
      // -----------------------------------------------------------------------
      let targetEntity = null;

      const numericId = typeof entityTypeOrId === 'number'
        ? entityTypeOrId
        : (Number.isFinite(Number(entityTypeOrId)) && !isNaN(Number(entityTypeOrId))
          ? Number(entityTypeOrId)
          : null);

      if (numericId !== null) {
        targetEntity = bot.entities[numericId] || null;
      } else {
        const found = findNearestFoodAnimal(bot, String(entityTypeOrId).toLowerCase(), maxSearchDistance);
        targetEntity = found ? found.entity : null;
      }

      if (!targetEntity) {
        return {
          outcome: 'failed',
          reason: 'entity_not_found',
          message: `No eligible adult ${entityTypeOrId} found within ${maxSearchDistance} blocks (or population limit reached)`,
        };
      }

      const entityType = targetEntity.name || targetEntity.type;
      const entityId = targetEntity.id;
      const expectedDrops = ANIMAL_DROPS[entityType] || [];

      // -----------------------------------------------------------------------
      // 2. Population preservation check (require >= 3 adults so >= 2 remain)
      // -----------------------------------------------------------------------
      const adultCount = countEligibleAdults(bot, entityType, maxSearchDistance);
      if (adultCount < 3) {
        return {
          outcome: 'failed',
          reason: 'population_preservation_limit',
          message: `Fewer than 3 adult ${entityType} nearby (${adultCount} found); preserving breeding pair`,
          details: { adultCount, minRequired: 3 },
        };
      }

      // -----------------------------------------------------------------------
      // 3. Record baseline inventory & listen for dropped items
      // -----------------------------------------------------------------------
      const baselineCounts = getInventoryCounts(bot);
      const droppedItemsTracked = [];
      let deathPosition = null;

      const onEntitySpawn = (e) => {
        if (e && e.name === 'item' && e.position) {
          droppedItemsTracked.push(e);
        }
      };
      if (typeof bot.on === 'function') {
        bot.on('entitySpawn', onEntitySpawn);
      }

      // -----------------------------------------------------------------------
      // 4. Navigate within melee range
      // -----------------------------------------------------------------------
      if (signal.aborted) {
        if (typeof bot.removeListener === 'function') bot.removeListener('entitySpawn', onEntitySpawn);
        return { outcome: 'cancelled', reason: 'cancelled_before_first_hit' };
      }

      try {
        const navGoal = new goals.GoalFollow(targetEntity, meleeRange);
        if (bot.pathfinder) {
          bot.pathfinder.setGoal(navGoal, true); // dynamic follow
        }

        await new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (signal.aborted) {
              clearInterval(checkInterval);
              resolve();
              return;
            }
            // Check if entity disappeared during approach
            if (!bot.entities[entityId]) {
              clearInterval(checkInterval);
              resolve();
              return;
            }
            const pos = targetEntity.position;
            const bpos = bot.entity?.position;
            if (!pos || !bpos) {
              clearInterval(checkInterval);
              resolve();
              return;
            }
            const dist = safeDistance(bot.entity.position, pos);
            if (dist <= meleeRange + 0.5) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);

          signal.addEventListener('abort', () => {
            clearInterval(checkInterval);
            resolve();
          }, { once: true });
        });
      } catch (err) {
        // Pathfinder error
      }

      if (signal.aborted) {
        try { bot.pathfinder?.stop?.(); } catch { /* ignore */ }
        if (typeof bot.removeListener === 'function') bot.removeListener('entitySpawn', onEntitySpawn);
        return { outcome: 'cancelled', reason: 'cancelled_before_first_hit' };
      }

      try { bot.pathfinder?.stop?.(); } catch { /* ignore */ }

      // Check if target was lost during approach
      if (!bot.entities[entityId]) {
        if (typeof bot.removeListener === 'function') bot.removeListener('entitySpawn', onEntitySpawn);
        return { outcome: 'failed', reason: 'target_lost', message: 'Target entity disappeared during approach' };
      }

      // Check if distance is still unreachable
      if (targetEntity.position && bot.entity?.position) {
        const dist = safeDistance(bot.entity.position, targetEntity.position);
        if (dist > meleeRange + 2.0) {
          if (typeof bot.removeListener === 'function') bot.removeListener('entitySpawn', onEntitySpawn);
          return { outcome: 'failed', reason: 'path_unreachable', message: 'Failed to reach melee range' };
        }
      }

      // -----------------------------------------------------------------------
      // 5. Pre-Attack Re-check: ensure >= 3 eligible adults still present!
      // -----------------------------------------------------------------------
      const recheckAdults = countEligibleAdults(bot, entityType, maxSearchDistance);
      if (recheckAdults < 3) {
        if (typeof bot.removeListener === 'function') bot.removeListener('entitySpawn', onEntitySpawn);
        return {
          outcome: 'failed',
          reason: 'population_preservation_limit',
          message: `Adult count dropped to ${recheckAdults} before first attack; preserving breeding pair`,
          details: { adultCount: recheckAdults, minRequired: 3 },
        };
      }

      // -----------------------------------------------------------------------
      // 6. Multi-hit attack loop
      // -----------------------------------------------------------------------
      const attackStarted = Date.now();
      let lastHealth = targetEntity.health ?? null;

      while (!signal.aborted) {
        if (!bot.entities[entityId]) {
          deathConfirmed = true;
          break;
        }

        deathPosition = targetEntity.position
          ? (typeof targetEntity.position.clone === 'function' ? targetEntity.position.clone() : { ...targetEntity.position })
          : (typeof bot.entity?.position?.clone === 'function' ? bot.entity.position.clone() : { ...bot.entity?.position });

        hitAttempted++;
        try {
          await bot.attack(bot.entities[entityId]);
          // Observe damage: entity still exists with reduced health, or entity died
          if (!bot.entities[entityId]) {
            deathConfirmed = true;
            damageConfirmed = true;
            break;
          }
          if (lastHealth !== null && targetEntity.health < lastHealth) {
            damageConfirmed = true;
            lastHealth = targetEntity.health;
          } else {
            // Assume attack packet confirmed damage attempt
            damageConfirmed = true;
          }
        } catch {
          if (!bot.entities[entityId]) {
            deathConfirmed = true;
            damageConfirmed = true;
          }
          break;
        }

        // Wait cooldown between hits (500ms)
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 500);
          if (t.unref) t.unref();
          signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });

        if (!bot.entities[entityId]) {
          deathConfirmed = true;
          break;
        }

        if (Date.now() - attackStarted > timeoutMs - 500) {
          break;
        }
      }

      if (typeof bot.removeListener === 'function') {
        bot.removeListener('entitySpawn', onEntitySpawn);
      }

      // Cancellation check: conservative reporting if attack packet was already sent
      if (signal.aborted) {
        if (hitAttempted > 0) {
          return {
            outcome: 'cancelled_after_effect',
            reason: 'cancelled_after_effect',
            details: {
              hitAttempted,
              damageConfirmed,
              deathConfirmed,
              entityId,
              entityType,
            },
          };
        }
        return { outcome: 'cancelled', reason: 'cancelled_before_first_hit' };
      }

      // Check external kill (entity died with 0 hits attempted)
      if (deathConfirmed && hitAttempted === 0) {
        return {
          outcome: 'failed',
          reason: 'killed_externally',
          message: 'Target entity was killed by an external source',
          details: { entityType, entityId },
        };
      }

      // -----------------------------------------------------------------------
      // 7. Strict Drop Collection & Attribution
      // -----------------------------------------------------------------------
      let attributionMethod = 'inventory_inference';

      if (deathConfirmed) {
        // Wait for drop items to spawn and settle
        await new Promise((r) => setTimeout(r, 800));

        const targetPos = deathPosition || (bot.entity ? bot.entity.position : null);

        // Find candidate dropped item entities from tracked events and active entities
        const dropsFromEntities = Object.values(bot.entities || {}).filter(e =>
          e && e.name === 'item' && e.position && safeDistance(e.position, targetPos) <= 5.0
        );
        const allCandidateDrops = [...droppedItemsTracked, ...dropsFromEntities];
        const nearbyDrops = targetPos
          ? allCandidateDrops.filter(e => e.position && safeDistance(e.position, targetPos) <= 5.0)
          : [];

        if (nearbyDrops.length > 0 || targetPos) {
          attributionMethod = 'entity_tracking';
          const navTarget = (nearbyDrops[0] && nearbyDrops[0].position) ? nearbyDrops[0].position : targetPos;
          if (bot.pathfinder && navTarget) {
            try {
              const pGoal = new goals.GoalNear(navTarget.x, navTarget.y, navTarget.z, 0.5);
              await bot.pathfinder.goto(pGoal);
            } catch {
              // Target reached or vacuumed automatically
            }
          }
        }

        // Poll for inventory drop settlement (up to 5000ms)
        const pollStart = Date.now();
        while (Date.now() - pollStart < 5000) {
          const currentInv = getInventoryCounts(bot);
          const currentDelta = computeInventoryDelta(baselineCounts, currentInv);
          const hasMatchedDrop = currentDelta.some(d => d.delta > 0 && expectedDrops.includes(d.name));
          if (hasMatchedDrop) break;
          await new Promise(r => setTimeout(r, 200));
        }
      }

      const finalCounts = getInventoryCounts(bot);
      const delta = computeInventoryDelta(baselineCounts, finalCounts);
      const matchedLoot = delta.filter(d => d.delta > 0 && expectedDrops.includes(d.name));
      const unrelatedGains = delta.filter(d => d.delta > 0 && !expectedDrops.includes(d.name));

      if (!deathConfirmed) {
        return {
          outcome: 'failed',
          reason: 'timed_out',
          message: `${entityType} was not killed within timeout`,
          details: {
            entityType,
            entityId,
            hitAttempted,
            damageConfirmed,
            deathConfirmed: false,
            matchedLoot,
            unrelatedGains,
          },
        };
      }

      return {
        outcome: 'success',
        reason: 'death_confirmed',
        details: {
          entityType,
          entityId,
          hitAttempted,
          damageConfirmed: true,
          deathConfirmed: true,
          attributionMethod,
          matchedLoot,
          unrelatedGains,
          expectedDrops,
        },
      };
    });
  }

  return {
    attack,
    isFoodAnimal,
    isEligibleAdultAnimal,
    countEligibleAdults,
    findNearestFoodAnimal,
    FOOD_ANIMAL_TYPES,
    ANIMAL_DROPS,
  };
}

module.exports = {
  createAttacker,
  isFoodAnimal,
  isEligibleAdultAnimal,
  countEligibleAdults,
  findNearestFoodAnimal,
  FOOD_ANIMAL_TYPES,
  ANIMAL_DROPS,
};
