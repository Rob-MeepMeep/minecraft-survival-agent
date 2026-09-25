'use strict';

/**
 * Produces a compact observation snapshot from the current bot state.
 *
 * Unknown or unloaded values are represented as null.
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {object}
 */
function snapshot(bot) {
  const pos = bot.entity?.position;
  const time = bot.time;

  // Nearby hostile mobs within 16 blocks.
  const hostileMobs = new Set([
    'zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'enderman',
    'witch', 'slime', 'phantom', 'drowned', 'husk', 'stray', 'pillager',
    'vindicator', 'ravager', 'evoker', 'vex', 'blaze', 'ghast',
    'magma_cube', 'hoglin', 'piglin_brute', 'warden', 'wither_skeleton',
    'zombified_piglin', 'guardian', 'elder_guardian', 'shulker', 'breeze',
  ]);

  let nearbyThreats = [];
  let nearbyPlayers = [];

  if (bot.entities) {
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity || !entity.position || !pos) continue;
      const dist = entity.position.distanceTo(pos);

      if (entity.type === 'hostile' || hostileMobs.has(entity.name)) {
        if (dist <= 16) {
          nearbyThreats.push({
            name: entity.name || 'unknown',
            distance: round1(dist),
          });
        }
      }

      if (entity.type === 'player' && dist <= 32) {
        nearbyPlayers.push({
          name: entity.username || entity.name || 'unknown',
          distance: round1(dist),
        });
      }
    }
  }

  // Sort by distance ascending.
  nearbyThreats.sort((a, b) => a.distance - b.distance);
  nearbyPlayers.sort((a, b) => a.distance - b.distance);

  const timeOfDay = time?.timeOfDay ?? null;
  const isNight = timeOfDay !== null ? (timeOfDay >= 12500 && timeOfDay < 23500) : null;

  return {
    position: pos
      ? { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) }
      : null,
    dimension: bot.game?.dimension ?? null,
    health: bot.health ?? null,
    food: bot.food ?? null,
    saturation: bot.foodSaturation ?? null,
    timeOfDay,
    gameTime: timeOfDay,
    dayCount: time?.day ?? null,
    isNight,
    inventory: bot.inventory
      ? bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
      : null,
    nearbyThreats,
    nearbyPlayers,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { snapshot, round1 };
