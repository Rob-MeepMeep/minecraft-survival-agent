'use strict';

const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const goals = require('mineflayer-pathfinder').goals;

function getBlueprintFile() {
  return process.env.SHELTER_BLUEPRINT_PATH || path.join(process.cwd(), '.shelter_blueprint.json');
}

const BLUEPRINT_FILE = path.join(process.cwd(), '.shelter_blueprint.json');

/** Approved solid building materials for shelter construction. */
const APPROVED_SHELTER_MATERIALS = new Set(['dirt', 'cobblestone', 'stone', 'grass_block']);

/** Replaceable surface vegetation that can be cleared during site preparation. */
const REPLACEABLE_VEGETATION = new Set([
  'short_grass', 'grass', 'tall_grass', 'dead_bush', 'dandelion',
  'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac',
  'rose_bush', 'peony', 'snow',
]);

/** Hazardous blocks that disqualify a shelter site. */
const HAZARDOUS_BLOCKS = new Set([
  'lava', 'flowing_lava', 'water', 'flowing_water', 'fire', 'soul_fire', 'powder_snow',
  'sweet_berry_bush', 'cactus', 'magma_block', 'wither_rose',
]);

/**
 * Checks whether a block name is replaceable vegetation.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isReplaceableVegetation(name) {
  return REPLACEABLE_VEGETATION.has(name);
}

/**
 * Checks whether a block name is a hazard.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isHazardousBlock(name) {
  return HAZARDOUS_BLOCKS.has(name);
}

/**
 * Evaluates candidate sites to find a safe, stable natural 3x3 footprint.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} [failureTracker]
 * @param {number} [maxRadius=16]
 * @returns {{ site: {x: number, y: number, z: number}, center: {x: number, y: number, z: number}, exitDirection: {x: number, y: number, z: number} } | null}
 */
function findSafeShelterSite(bot, failureTracker = null, maxRadius = 16) {
  if (!bot || !bot.entity?.position || !bot.blockAt) return null;

  const origin = bot.entity.position.floored();

  // Candidate offsets ordered by proximity to current bot position
  const candidates = [];
  for (let r = 0; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let dy of [0, -1, 1, -2, 2]) {
          candidates.push(new Vec3(origin.x + dx, origin.y + dy, origin.z + dz));
        }
      }
    }
  }

  for (const center of candidates) {
    if (failureTracker) {
      const siteKey = `shelter_site_${center.x}_${center.y}_${center.z}`;
      if (failureTracker.isOnCooldown(siteKey)) continue;
    }

    const evalResult = evaluateSiteCandidate(bot, center);
    if (evalResult && evalResult.safe) {
      return {
        site: { x: center.x, y: center.y, z: center.z },
        center: { x: center.x, y: center.y, z: center.z },
        exitDirection: evalResult.exitDirection,
      };
    }
  }

  return null;
}

/**
 * Evaluates a single 3x3 candidate center position.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Vec3} center
 * @returns {{ safe: boolean, exitDirection: { x: number, y: number, z: number } } | null}
 */
function evaluateSiteCandidate(bot, center) {
  // 1. Flooring Check: all 9 blocks at y-1 must be solid natural blocks
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const floorPos = center.offset(dx, -1, dz);
      const floorBlock = bot.blockAt(floorPos);
      if (!floorBlock || floorBlock.boundingBox !== 'block') return null;
      if (['sand', 'gravel'].includes(floorBlock.name)) {
        // Unstable ground check: sand/gravel directly over air/fluid
        const underFloor = bot.blockAt(floorPos.offset(0, -1, 0));
        if (!underFloor || underFloor.boundingBox !== 'block') return null;
      }
      if (isHazardousBlock(floorBlock.name)) return null;
    }
  }

  // 2. Interior Clearance: center at y=0 and y=1 must be clear air or replaceable vegetation
  for (let dy = 0; dy <= 1; dy++) {
    const intBlock = bot.blockAt(center.offset(0, dy, 0));
    if (!intBlock) return null;
    if (intBlock.boundingBox === 'block') return null;
    if (intBlock.name !== 'air' && !isReplaceableVegetation(intBlock.name)) return null;
    if (isHazardousBlock(intBlock.name)) return null;
  }

  // 3. Wall and Roof Clearance: 16 walls (y=0,1) and 9 roof (y=2)
  for (let dy = 0; dy <= 2; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dy < 2 && dx === 0 && dz === 0) continue; // interior checked above
        const pos = center.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        if (!block) return null;
        if (isHazardousBlock(block.name)) return null;
        // Foreign block check: reject player structures, chests, crafting tables, furnaces, ores
        if (['crafting_table', 'chest', 'furnace', 'trapped_chest', 'barrel'].includes(block.name)) return null;
        if (block.name.endsWith('_ore') || block.name.endsWith('_planks')) return null;
        if (block.boundingBox === 'block' && !APPROVED_SHELTER_MATERIALS.has(block.name)) return null;
      }
    }
  }

  // 4. Entity Collision Check: no players or hostile mobs intersecting footprint
  if (bot.entities) {
    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position) continue;
      if (entity === bot.entity) continue;
      const ex = entity.position.x;
      const ey = entity.position.y;
      const ez = entity.position.z;
      if (
        ex >= center.x - 1.5 && ex <= center.x + 2.5 &&
        ez >= center.z - 1.5 && ez <= center.z + 2.5 &&
        ey >= center.y - 1 && ey <= center.y + 3
      ) {
        return null;
      }
    }
  }

  // 5. Exit Selection: evaluate 4 cardinal exit directions
  const cardinals = [
    { x: 0, y: 0, z: 1 },  // South (+Z)
    { x: 0, y: 0, z: -1 }, // North (-Z)
    { x: 1, y: 0, z: 0 },  // East (+X)
    { x: -1, y: 0, z: 0 }, // West (-X)
  ];

  for (const exitDir of cardinals) {
    const exitGround = center.offset(exitDir.x * 2, -1, exitDir.z * 2);
    const landingGround = bot.blockAt(exitGround);
    const landingAir1 = bot.blockAt(center.offset(exitDir.x * 2, 0, exitDir.z * 2));
    const landingAir2 = bot.blockAt(center.offset(exitDir.x * 2, 1, exitDir.z * 2));

    // Must have solid footing and clear walkout room (no cliff, no obstruction, no hazard)
    if (
      landingGround && landingGround.boundingBox === 'block' && !isHazardousBlock(landingGround.name) &&
      landingAir1 && landingAir1.boundingBox !== 'block' && !isHazardousBlock(landingAir1.name) &&
      landingAir2 && landingAir2.boundingBox !== 'block' && !isHazardousBlock(landingAir2.name)
    ) {
      return { safe: true, exitDirection: exitDir };
    }
  }

  return null;
}

/**
 * Creates the deterministic 25-block shelter blueprint.
 *
 * Sequence:
 * 1. Lower perimeter walls (7 blocks, omitting exit coordinate)
 * 2. Upper perimeter walls (7 blocks, omitting exit coordinate)
 * 3. Roof perimeter (8 blocks)
 * 4. Roof center (1 block overhead)
 * 5. Exit column (2 blocks: lower exit block, upper exit block sealed from inside)
 *
 * @param {{x: number, y: number, z: number}} center
 * @param {{x: number, y: number, z: number}} exitDirection
 * @param {string} [material='dirt']
 * @param {object} [metadata={}]
 * @returns {object} ShelterBlueprint
 */
function createShelterBlueprint(center, exitDirection, material = 'dirt', metadata = {}) {
  const cx = Math.floor(center.x);
  const cy = Math.floor(center.y);
  const cz = Math.floor(center.z);

  const exitX = cx + exitDirection.x;
  const exitZ = cz + exitDirection.z;

  const requiredCoordinates = [];

  // Perimeter (dx, dz) in clockwise order starting North
  const perimeterDeltas = [
    { dx: 0, dz: -1 },
    { dx: 1, dz: -1 },
    { dx: 1, dz: 0 },
    { dx: 1, dz: 1 },
    { dx: 0, dz: 1 },
    { dx: -1, dz: 1 },
    { dx: -1, dz: 0 },
    { dx: -1, dz: -1 },
  ];

  // Phase 1: Lower walls (y = 0, omitting doorway)
  for (const { dx, dz } of perimeterDeltas) {
    const x = cx + dx;
    const z = cz + dz;
    if (x === exitX && z === exitZ) continue; // exit column deferred to end
    requiredCoordinates.push({
      x, y: cy, z,
      phase: 'lower_walls',
      blockIndex: requiredCoordinates.length + 1,
      material,
      expectedMaterial: material,
      verified: false,
    });
  }

  // Phase 2: Upper walls (y = 1, omitting doorway)
  for (const { dx, dz } of perimeterDeltas) {
    const x = cx + dx;
    const z = cz + dz;
    if (x === exitX && z === exitZ) continue; // exit column deferred to end
    requiredCoordinates.push({
      x, y: cy + 1, z,
      phase: 'upper_walls',
      blockIndex: requiredCoordinates.length + 1,
      material,
      expectedMaterial: material,
      verified: false,
    });
  }

  // Phase 3: Roof perimeter (y = 2, all 8 perimeter blocks)
  for (const { dx, dz } of perimeterDeltas) {
    requiredCoordinates.push({
      x: cx + dx, y: cy + 2, z: cz + dz,
      phase: 'roof_perimeter',
      blockIndex: requiredCoordinates.length + 1,
      material,
      expectedMaterial: material,
      verified: false,
    });
  }

  // Phase 4: Roof center (y = 2, directly overhead)
  requiredCoordinates.push({
    x: cx, y: cy + 2, z: cz,
    phase: 'roof_center',
    blockIndex: requiredCoordinates.length + 1,
    material,
    expectedMaterial: material,
    verified: false,
  });

  // Phase 5: Exit column (sealed last from inside)
  requiredCoordinates.push({
    x: exitX, y: cy, z: exitZ,
    phase: 'exit_column',
    blockIndex: requiredCoordinates.length + 1,
    material,
    expectedMaterial: material,
    verified: false,
  });
  requiredCoordinates.push({
    x: exitX, y: cy + 1, z: exitZ,
    phase: 'exit_column',
    blockIndex: requiredCoordinates.length + 1,
    material,
    expectedMaterial: material,
    verified: false,
  });

  return {
    id: `shelter-${Date.now()}`,
    site: { x: cx, y: cy, z: cz },
    center: { x: cx, y: cy, z: cz },
    exitDirection: { x: exitDirection.x, y: 0, z: exitDirection.z },
    exitCoordinates: [
      { x: exitX, y: cy, z: exitZ, layer: 0, expectedMaterial: material },
      { x: exitX, y: cy + 1, z: exitZ, layer: 1, expectedMaterial: material },
    ],
    material,
    requiredCoordinates,
    verifiedCoordinates: [],
    materialsConsumed: [],
    buildState: 'planning', // planning | positioning | building | enclosed | waiting | exiting | completed | abandoned
    server: metadata.server || 'localhost:25565',
    worldId: metadata.worldId || 'overworld',
    dimension: metadata.dimension || 'overworld',
    mcVersion: metadata.mcVersion || '1.20',
    sessionId: metadata.sessionId || `session-${Date.now()}`,
    controllerRunId: metadata.controllerRunId || 'run-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Saves shelter blueprint atomically to disk.
 *
 * @param {object} blueprint
 */
function saveBlueprint(blueprint) {
  try {
    blueprint.updatedAt = Date.now();
    const file = getBlueprintFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(blueprint, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // Disk write error
  }
}

/**
 * Loads shelter blueprint from disk if it exists and is structurally valid.
 *
 * @returns {object|null}
 */
function loadBlueprint() {
  try {
    const file = getBlueprintFile();
    if (!fs.existsSync(file)) return null;
    const data = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.center || typeof parsed.center.x !== 'number' || typeof parsed.center.y !== 'number' || typeof parsed.center.z !== 'number') {
      return null;
    }
    if (!Array.isArray(parsed.requiredCoordinates) || !Array.isArray(parsed.verifiedCoordinates)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Clears shelter blueprint file from disk.
 */
function clearBlueprint() {
  try {
    const file = getBlueprintFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // ignore
  }
}

/**
 * Validates blueprint identity against the active session, world, dimension, server, version, and player vitality.
 *
 * @param {object} blueprint
 * @param {import('mineflayer').Bot} bot
 * @param {object} [context={}]
 * @returns {boolean}
 */
function validateBlueprintIdentity(blueprint, bot, context = {}) {
  if (!blueprint || !blueprint.center) return false;
  if (blueprint.buildState === 'abandoned' || blueprint.buildState === 'completed') return false;

  let isValid = true;

  // 1. Check vitality / death: if player died, blueprint must be abandoned
  if (bot?.entity?.health !== undefined && bot.entity.health <= 0) isValid = false;
  if (bot?.isDead) isValid = false;

  // 2. Verify dimension match
  const currentDim = context.dimension || bot?.game?.dimension || 'overworld';
  if (blueprint.dimension && blueprint.dimension !== currentDim) isValid = false;

  // 3. Verify server identity
  const currentServer = context.server ||
    bot?._client?.socket?.remoteAddress ||
    (bot?._client?.host ? `${bot._client.host}:${bot._client.port || 25565}` : null);
  if (blueprint.server && currentServer && blueprint.server !== currentServer) isValid = false;

  // 4. Verify world identity
  const currentWorldId = context.worldId || bot?.worldId || bot?.game?.worldId || bot?.game?.levelName;
  if (blueprint.worldId && currentWorldId && blueprint.worldId !== currentWorldId) isValid = false;

  // 5. Verify version
  const currentVersion = context.mcVersion || bot?.version;
  if (blueprint.mcVersion && currentVersion && blueprint.mcVersion !== currentVersion) isValid = false;

  // 6. Verify distance: if bot is > 64m away from shelter center, it respawned or moved away
  if (bot?.entity?.position) {
    const pos = bot.entity.position;
    const dx = pos.x - (blueprint.center.x + 0.5);
    const dy = pos.y - blueprint.center.y;
    const dz = pos.z - (blueprint.center.z + 0.5);
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > 64) isValid = false;
  }

  if (!isValid) {
    blueprint.buildState = 'abandoned';
    saveBlueprint(blueprint);
    return false;
  }

  return true;
}

/**
 * Performs a comprehensive 34-block enclosure audit and validates full player bounding-box containment.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} blueprint
 * @returns {{ enclosed: boolean, missingCoordinates: Array<{x: number, y: number, z: number}>, foreignBlocks: Array<object>, floorIntact: boolean, interiorClear: boolean, playerInside: boolean, details: object }}
 */
function auditEnclosure(bot, blueprint) {
  if (!bot || !blueprint || !blueprint.center) {
    return { enclosed: false, missingCoordinates: [], foreignBlocks: [], floorIntact: false, interiorClear: false, playerInside: false, details: {} };
  }

  const cx = blueprint.center.x;
  const cy = blueprint.center.y;
  const cz = blueprint.center.z;
  const expectedMaterial = blueprint.material || 'dirt';

  const missingCoordinates = [];
  const foreignBlocks = [];

  // 1. Audit all 25 blueprint required coordinates (16 walls + 9 roof)
  for (const coord of blueprint.requiredCoordinates) {
    const block = bot.blockAt(new Vec3(coord.x, coord.y, coord.z));
    if (!block || block.boundingBox !== 'block') {
      missingCoordinates.push({ x: coord.x, y: coord.y, z: coord.z });
      continue;
    }
    // Tightened idempotent check: an occupied coordinate is ONLY complete if it matches recorded approved shelter material
    const expected = coord.expectedMaterial || expectedMaterial;
    const isApprovedMaterial = (block.name === expected) || (APPROVED_SHELTER_MATERIALS.has(block.name) && APPROVED_SHELTER_MATERIALS.has(expected));
    if (!isApprovedMaterial) {
      foreignBlocks.push({ x: coord.x, y: coord.y, z: coord.z, block: block.name, expected });
    }
  }

  // 2. Audit 9 Floor blocks at y-1
  let floorIntact = true;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const fBlock = bot.blockAt(new Vec3(cx + dx, cy - 1, cz + dz));
      if (!fBlock || fBlock.boundingBox !== 'block') {
        floorIntact = false;
        missingCoordinates.push({ x: cx + dx, y: cy - 1, z: cz + dz });
      }
    }
  }

  // 3. Audit Interior Clearance: center at y=0 and y=1 must be clear non-solid air
  let interiorClear = true;
  for (let dy = 0; dy <= 1; dy++) {
    const intBlock = bot.blockAt(new Vec3(cx, cy + dy, cz));
    if (intBlock && intBlock.boundingBox === 'block') {
      interiorClear = false;
    }
  }

  // 4. Full Player Bounding Box Containment
  // Integer block coordinate center has bounds: [cx, cx + 1] x [cy, cy + 2] x [cz, cz + 1]
  // In Minecraft, a centered player stands near (cx + 0.5, cy, cz + 0.5).
  // Player AABB has half-width 0.3, height 1.8:
  let playerInside = false;
  if (bot.entity?.position) {
    const pos = bot.entity.position;
    const playerMinX = pos.x - 0.3;
    const playerMaxX = pos.x + 0.3;
    const playerMinY = pos.y;
    const playerMaxY = pos.y + 1.8;
    const playerMinZ = pos.z - 0.3;
    const playerMaxZ = pos.z + 0.3;

    const interiorMinX = cx;
    const interiorMaxX = cx + 1.0;
    const interiorMinY = cy - 0.2; // slight tolerance for standing on floor
    const interiorMaxY = cy + 2.0;
    const interiorMinZ = cz;
    const interiorMaxZ = cz + 1.0;

    const eps = 0.05;
    playerInside = (
      playerMinX >= interiorMinX - eps && playerMaxX <= interiorMaxX + eps &&
      playerMinZ >= interiorMinZ - eps && playerMaxZ <= interiorMaxZ + eps &&
      playerMinY >= interiorMinY - eps && playerMaxY <= interiorMaxY + eps
    );
  }

  const enclosed = missingCoordinates.length === 0 &&
    foreignBlocks.length === 0 &&
    floorIntact &&
    interiorClear &&
    playerInside;

  return {
    enclosed,
    missingCoordinates,
    foreignBlocks,
    floorIntact,
    interiorClear,
    playerInside,
    details: {
      totalRequired: blueprint.requiredCoordinates.length,
      verifiedCount: blueprint.requiredCoordinates.length - missingCoordinates.length,
      missingCount: missingCoordinates.length,
      foreignCount: foreignBlocks.length,
      playerInside,
    },
  };
}

/**
 * Checks safety outside the intended exit doorway before breaking blocks at dawn.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} blueprint
 * @param {{x: number, y?: number, z: number}} [exitDirection] - optional candidate exit direction
 * @returns {{ safe: boolean, reason: string }}
 */
function checkExitSafety(bot, blueprint, exitDirection = null) {
  if (!bot || !blueprint || !blueprint.center) {
    return { safe: false, reason: 'missing_blueprint' };
  }

  const exitDir = exitDirection || blueprint.exitDirection;
  if (!exitDir) {
    return { safe: false, reason: 'missing_exit_direction' };
  }

  const cx = blueprint.center.x;
  const cy = blueprint.center.y;
  const cz = blueprint.center.z;
  const edx = exitDir.x;
  const edz = exitDir.z;

  const exteriorGround = new Vec3(cx + edx * 2, cy - 1, cz + edz * 2);
  const landing = bot.blockAt ? bot.blockAt(exteriorGround) : null;
  if (!landing || landing.boundingBox !== 'block') {
    return { safe: false, reason: 'unsafe_outside_footing' };
  }

  const ext1 = bot.blockAt ? bot.blockAt(new Vec3(cx + edx * 2, cy, cz + edz * 2)) : null;
  const ext2 = bot.blockAt ? bot.blockAt(new Vec3(cx + edx * 2, cy + 1, cz + edz * 2)) : null;

  for (const b of [landing, ext1, ext2]) {
    if (b && isHazardousBlock(b.name)) {
      if (b.name.includes('water') || b.name.includes('lava')) {
        return { safe: false, reason: `fluid_outside_exit_${b.name}` };
      }
      return { safe: false, reason: 'hazard_outside_exit' };
    }
  }

  // Entity check outside doorway
  if (bot.entities) {
    const extPos = new Vec3(cx + edx * 2, cy, cz + edz * 2);
    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position) continue;
      if (entity === bot.entity) continue;

      // Hostile threat check within 8m of exit
      const type = entity.name || entity.type;
      const isHostile = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman'].includes(type);
      if (isHostile && entity.position.distanceTo(extPos) <= 8.0) {
        return { safe: false, reason: `hostile_threat_${type}_at_exit` };
      }

      // Entity obstruction directly blocking exit doorway (passive mob, player, etc.)
      if (entity.position.distanceTo(extPos) <= 1.3) {
        return { safe: false, reason: 'entity_obstruction_at_exit' };
      }
    }
  }

  return { safe: true, reason: 'exit_safe' };

}

const CARDINAL_EXITS = [
  { x: 0, z: -1, name: 'north' },
  { x: 1, z: 0, name: 'east' },
  { x: 0, z: 1, name: 'south' },
  { x: -1, z: 0, name: 'west' },
];

/**
 * Searches for an alternative structurally sound and safe exit direction if the primary exit is blocked.
 * Requires:
 * 1. Two existing solid shelter blocks (or clear doorway) at layer 0 and layer 1 for that wall.
 * 2. Complete exit safety (solid landing, no fluid/hazard, no obstruction <= 1.3m, no hostile threats <= 8m).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} blueprint
 * @returns {{ direction: {x: number, y: number, z: number}, name: string, exitCoordinates: Array<{x: number, y: number, z: number, layer: number}> } | null}
 */
function findAlternativeSafeExit(bot, blueprint) {
  if (!bot || !blueprint || !blueprint.center) return null;
  const cx = blueprint.center.x;
  const cy = blueprint.center.y;
  const cz = blueprint.center.z;
  const currentEdx = blueprint.exitDirection?.x ?? 0;
  const currentEdz = blueprint.exitDirection?.z ?? 1;

  for (const cand of CARDINAL_EXITS) {
    if (cand.x === currentEdx && cand.z === currentEdz) continue;

    const candDir = { x: cand.x, y: 0, z: cand.z };
    const lowerCoord = { x: cx + cand.x, y: cy, z: cz + cand.z, layer: 0 };
    const upperCoord = { x: cx + cand.x, y: cy + 1, z: cz + cand.z, layer: 1 };

    if (bot.blockAt) {
      const b0 = bot.blockAt(new Vec3(lowerCoord.x, lowerCoord.y, lowerCoord.z));
      const b1 = bot.blockAt(new Vec3(upperCoord.x, upperCoord.y, upperCoord.z));
      if (!b0 || !b1) continue;
      const expectedMat = blueprint.material || 'dirt';
      const valid0 = b0.name === 'air' || b0.name === expectedMat || APPROVED_SHELTER_MATERIALS.has(b0.name);
      const valid1 = b1.name === 'air' || b1.name === expectedMat || APPROVED_SHELTER_MATERIALS.has(b1.name);
      if (!valid0 || !valid1) continue;
    }

    const safety = checkExitSafety(bot, blueprint, candDir);
    if (safety.safe) {
      return {
        direction: candDir,
        name: cand.name,
        exitCoordinates: [lowerCoord, upperCoord],
      };
    }
  }

  return null;
}

module.exports = {
  findSafeShelterSite,
  evaluateSiteCandidate,
  createShelterBlueprint,
  saveBlueprint,
  loadBlueprint,
  clearBlueprint,
  validateBlueprintIdentity,
  auditEnclosure,
  checkExitSafety,
  findAlternativeSafeExit,
  isReplaceableVegetation,
  isHazardousBlock,
  APPROVED_SHELTER_MATERIALS,
  BLUEPRINT_FILE,
};

