'use strict';

const { test, describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');

const {
  findSafeShelterSite,
  evaluateSiteCandidate,
  createShelterBlueprint,
  saveBlueprint,
  loadBlueprint,
  clearBlueprint,
  validateBlueprintIdentity,
  auditEnclosure,
  checkExitSafety,
  isReplaceableVegetation,
  isHazardousBlock,
  APPROVED_SHELTER_MATERIALS,
} = require('../src/actions/shelter');

const TEST_BP_PATH = path.join(__dirname, `.shelter_test_${process.pid}.json`);
process.env.SHELTER_BLUEPRINT_PATH = TEST_BP_PATH;

const {
  GoalPlanner,
  getExpendableBuildingBlocks,
  getLatestSafeGatherStart,
  SHELTER_PREP_TIME,
  SHELTER_DEADLINE,
  DAWN_TIME,
} = require('../src/controller/planner');

const { SurvivalController } = require('../src/controller/survival_controller');
const { ActionManager } = require('../src/actions/manager');

// ---------------------------------------------------------------------------
// Helpers and Mock Generators
// ---------------------------------------------------------------------------

function createMockBot(overrides = {}) {
  const inventoryItems = overrides.items || [];
  const entitiesMap = overrides.entities || {};

  const blocks = new Map();
  if (overrides.blocks) {
    for (const [key, b] of Object.entries(overrides.blocks)) {
      blocks.set(key, b);
    }
  }

  const mock = {
    entity: {
      position: overrides.playerPos || new Vec3(10.5, 64, 20.5),
    },
    entities: entitiesMap,
    inventory: {
      items: () => inventoryItems,
    },
    registry: {
      blocksByName: {
        dirt: { id: 3, name: 'dirt' },
        cobblestone: { id: 4, name: 'cobblestone' },
        stone: { id: 1, name: 'stone' },
        crafting_table: { id: 58, name: 'crafting_table' },
      },
    },
    blockAt: overrides.blockAt || ((pos) => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      if (blocks.has(key)) return blocks.get(key);
      // Default: solid dirt floor at y=63, air at y>=64
      if (Math.floor(pos.y) < 64) {
        return { name: 'dirt', boundingBox: 'block', position: new Vec3(pos.x, pos.y, pos.z) };
      }
      return { name: 'air', boundingBox: 'empty', position: new Vec3(pos.x, pos.y, pos.z) };
    }),
    findBlock: overrides.findBlock || (() => null),
    time: overrides.time || { timeOfDay: 1000, day: 1 },
    game: { dimension: overrides.dimension || 'overworld' },
    version: overrides.version || '1.20',
    food: overrides.food ?? 20,
    health: overrides.health ?? 20,
    foodSaturation: overrides.foodSaturation ?? 5,
    on: () => {},
    removeListener: () => {},
    clearControlStates: () => {},
    ...overrides,
  };

  return mock;
}

function buildEnclosedBlocks(center, material = 'dirt') {
  const blocks = {};
  const cx = Math.floor(center.x);
  const cy = Math.floor(center.y);
  const cz = Math.floor(center.z);

  // 1. Floor at y-1 (9 blocks)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      blocks[`${cx + dx},${cy - 1},${cz + dz}`] = {
        name: material,
        boundingBox: 'block',
        position: new Vec3(cx + dx, cy - 1, cz + dz),
      };
    }
  }

  // 2. Walls at y=0 and y=1 (16 blocks: 8 per layer around perimeter)
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) {
          // Interior air
          blocks[`${cx},${cy + dy},${cz}`] = {
            name: 'air',
            boundingBox: 'empty',
            position: new Vec3(cx, cy + dy, cz),
          };
        } else {
          blocks[`${cx + dx},${cy + dy},${cz + dz}`] = {
            name: material,
            boundingBox: 'block',
            position: new Vec3(cx + dx, cy + dy, cz + dz),
          };
        }
      }
    }
  }

  // 3. Roof at y=2 (9 blocks)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      blocks[`${cx + dx},${cy + 2},${cz + dz}`] = {
        name: material,
        boundingBox: 'block',
        position: new Vec3(cx + dx, cy + 2, cz + dz),
      };
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stage 3D — Shelter Site Evaluation & Safety Filter', () => {
  it('evaluates safe natural site with solid floor, clear interior, and valid exit', () => {
    const center = new Vec3(10, 64, 20);
    const bot = createMockBot();
    const result = evaluateSiteCandidate(bot, center);
    assert.ok(result);
    assert.equal(result.safe, true);
    assert.ok(result.exitDirection);
  });

  it('rejects site with hazard block in floor or interior (water/lava/berry bush)', () => {
    const center = new Vec3(10, 64, 20);
    // Water in floor
    const bot1 = createMockBot({
      blocks: {
        '10,63,20': { name: 'water', boundingBox: 'empty' },
      },
    });
    assert.equal(evaluateSiteCandidate(bot1, center), null);

    // Sweet berry bush in interior
    const bot2 = createMockBot({
      blocks: {
        '10,64,20': { name: 'sweet_berry_bush', boundingBox: 'empty' },
      },
    });
    assert.equal(evaluateSiteCandidate(bot2, center), null);
  });

  it('rejects unstable ground (sand over air)', () => {
    const center = new Vec3(10, 64, 20);
    const bot = createMockBot({
      blocks: {
        '10,63,20': { name: 'sand', boundingBox: 'block' },
        '10,62,20': { name: 'air', boundingBox: 'empty' }, // air beneath sand
      },
    });
    assert.equal(evaluateSiteCandidate(bot, center), null);
  });

  it('rejects candidate site containing player structures or foreign blocks (chests, tables, ores)', () => {
    const center = new Vec3(10, 64, 20);
    const foreignTypes = ['crafting_table', 'chest', 'furnace', 'iron_ore', 'oak_planks'];
    for (const fType of foreignTypes) {
      const bot = createMockBot({
        blocks: {
          '11,64,20': { name: fType, boundingBox: 'block' },
        },
      });
      assert.equal(evaluateSiteCandidate(bot, center), null, `Should reject candidate with ${fType}`);
    }
  });

  it('rejects candidate site containing player structures or foreign blocks in floor', () => {
    const center = new Vec3(10, 64, 20);
    const foreignFloorTypes = ['crafting_table', 'chest', 'furnace', 'iron_ore', 'oak_planks'];
    for (const fType of foreignFloorTypes) {
      const bot = createMockBot({
        blocks: {
          '10,63,20': { name: fType, boundingBox: 'block' },
        },
      });
      assert.equal(evaluateSiteCandidate(bot, center), null, `Should reject candidate with ${fType} in floor`);
    }
  });

  it('rejects site when entity intersects footprint', () => {
    const center = new Vec3(10, 64, 20);
    const bot = createMockBot({
      entities: {
        'mob-1': {
          id: 101,
          name: 'zombie',
          position: new Vec3(10.5, 64, 20.5), // directly inside candidate footprint
        },
      },
    });
    assert.equal(evaluateSiteCandidate(bot, center), null);
  });
});

describe('Stage 3D — Deterministic Blueprint Generation & Placement Sequence', () => {
  it('generates deterministic 25-block blueprint with expected sequence and layer ordering', () => {
    const center = { x: 10, y: 64, z: 20 };
    const exitDirection = { x: 0, y: 0, z: 1 }; // South exit (doorway at 10, 64, 21)
    const bp = createShelterBlueprint(center, exitDirection, 'dirt', {
      server: 'localhost:61375',
      dimension: 'overworld',
      mcVersion: '1.20',
      sessionId: 'session-test-1',
    });

    assert.equal(bp.requiredCoordinates.length, 25);
    assert.equal(bp.material, 'dirt');
    assert.equal(bp.buildState, 'planning');

    // 1. Lower walls (7 blocks, omitting doorway at 10, 64, 21)
    const lower = bp.requiredCoordinates.filter(c => c.phase === 'lower_walls');
    assert.equal(lower.length, 7);
    lower.forEach(c => {
      assert.equal(c.y, 64);
      assert.equal(c.expectedMaterial, 'dirt');
      assert.equal(c.verified, false);
      assert.ok(!(c.x === 10 && c.z === 21)); // doorway omitted
    });

    // 2. Upper walls (7 blocks, omitting doorway at 10, 65, 21)
    const upper = bp.requiredCoordinates.filter(c => c.phase === 'upper_walls');
    assert.equal(upper.length, 7);
    upper.forEach(c => {
      assert.equal(c.y, 65);
      assert.equal(c.expectedMaterial, 'dirt');
      assert.equal(c.verified, false);
      assert.ok(!(c.x === 10 && c.z === 21)); // doorway omitted
    });

    // 3. Roof perimeter (8 blocks at y=66)
    const roofP = bp.requiredCoordinates.filter(c => c.phase === 'roof_perimeter');
    assert.equal(roofP.length, 8);
    roofP.forEach(c => {
      assert.equal(c.y, 66);
      assert.equal(c.expectedMaterial, 'dirt');
    });

    // 4. Roof center (1 block directly overhead at 10, 66, 20)
    const roofC = bp.requiredCoordinates.filter(c => c.phase === 'roof_center');
    assert.equal(roofC.length, 1);
    assert.deepEqual({ x: roofC[0].x, y: roofC[0].y, z: roofC[0].z }, { x: 10, y: 66, z: 20 });

    // 5. Exit column sealed last from inside (2 blocks: lower exit y=64, upper exit y=65)
    const exitCol = bp.requiredCoordinates.filter(c => c.phase === 'exit_column');
    assert.equal(exitCol.length, 2);
    assert.deepEqual({ x: exitCol[0].x, y: exitCol[0].y, z: exitCol[0].z }, { x: 10, y: 64, z: 21 });
    assert.deepEqual({ x: exitCol[1].x, y: exitCol[1].y, z: exitCol[1].z }, { x: 10, y: 65, z: 21 });
  });
});

describe('Stage 3D — Durable Blueprint Persistence & Identity Validation', () => {
  beforeEach(() => {
    clearBlueprint();
  });

  afterEach(() => {
    clearBlueprint();
  });

  it('saves and loads blueprint atomically from disk', () => {
    const center = { x: 10, y: 64, z: 20 };
    const exitDirection = { x: 0, y: 0, z: 1 };
    const bp = createShelterBlueprint(center, exitDirection, 'dirt', {
      server: 'localhost:61375',
      dimension: 'overworld',
    });

    saveBlueprint(bp);
    assert.ok(fs.existsSync(TEST_BP_PATH));

    const loaded = loadBlueprint();
    assert.ok(loaded);
    assert.equal(loaded.id, bp.id);
    assert.equal(loaded.requiredCoordinates.length, 25);
    assert.deepEqual(loaded.center, center);
  });

  it('validateBlueprintIdentity passes on matching dimension, server, and proximity', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt', {
      server: 'localhost:61375',
      dimension: 'overworld',
    });
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      dimension: 'overworld',
    });

    assert.equal(validateBlueprintIdentity(bp, bot, { server: 'localhost:61375', dimension: 'overworld' }), true);
  });

  it('validateBlueprintIdentity abandons state on dimension mismatch or remote respawn > 64m', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt', {
      dimension: 'overworld',
    });
    saveBlueprint(bp);

    // Dimension mismatch (e.g. nether)
    const netherBot = createMockBot({ dimension: 'the_nether' });
    assert.equal(validateBlueprintIdentity(bp, netherBot), false);
    assert.equal(bp.buildState, 'abandoned');

    // Remote respawn > 64m away
    const farBot = createMockBot({
      playerPos: new Vec3(200, 64, 200), // > 64m
      dimension: 'overworld',
    });
    bp.buildState = 'building';
    assert.equal(validateBlueprintIdentity(bp, farBot), false);
    assert.equal(bp.buildState, 'abandoned');
  });
});

describe('Stage 3D — Coordinate Convention & Player AABB Containment (Clarification 1)', () => {
  it('correctly accepts player standing at Mineflayer centered coordinates (center.x+0.5, center.z+0.5)', () => {
    const center = { x: 10, y: 64, z: 20 };
    const bp = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt');
    const blocks = buildEnclosedBlocks(center, 'dirt');

    // Standard Mineflayer centered coordinates: (10.5, 64, 20.5)
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      blocks,
    });

    const audit = auditEnclosure(bot, bp);
    assert.equal(audit.playerInside, true, 'Player at center.x+0.5, center.z+0.5 must be inside bounds');
    assert.equal(audit.missingCoordinates.length, 0);
    assert.equal(audit.enclosed, true);
  });

  it('accepts slight positioning jitter near center', () => {
    const center = { x: 10, y: 64, z: 20 };
    const bp = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt');
    const blocks = buildEnclosedBlocks(center, 'dirt');

    // Slight offset: (10.45, 64, 20.55) -> half-width 0.3 means x: [10.15, 10.75], z: [20.25, 20.85]
    const bot = createMockBot({
      playerPos: new Vec3(10.45, 64, 20.55),
      blocks,
    });

    const audit = auditEnclosure(bot, bp);
    assert.equal(audit.playerInside, true);
  });

  it('rejects player clipping walls (e.g. standing at integer block edge x=10.0 or x=11.0)', () => {
    const center = { x: 10, y: 64, z: 20 };
    const bp = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt');
    const blocks = buildEnclosedBlocks(center, 'dirt');

    // Standing at x=10.0 (half-width 0.3 means x min is 9.7, penetrating west wall at x=9)
    const botWestClip = createMockBot({
      playerPos: new Vec3(10.0, 64, 20.5),
      blocks,
    });
    assert.equal(auditEnclosure(botWestClip, bp).playerInside, false, 'Should reject west wall clipping');

    // Standing at x=11.0 (half-width 0.3 means x max is 11.3, penetrating east wall at x=11)
    const botEastClip = createMockBot({
      playerPos: new Vec3(11.0, 64, 20.5),
      blocks,
    });
    assert.equal(auditEnclosure(botEastClip, bp).playerInside, false, 'Should reject east wall clipping');
  });
});

describe('Stage 3D — Tightened Idempotent Checks & Foreign Block Rejection (Clarification 3)', () => {
  it('occupied blueprint coordinate counts as complete ONLY when containing approved shelter material', () => {
    const center = { x: 10, y: 64, z: 20 };
    const bp = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt');
    const blocks = buildEnclosedBlocks(center, 'dirt');

    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      blocks,
    });

    const audit = auditEnclosure(bot, bp);
    assert.equal(audit.enclosed, true);
    assert.equal(audit.foreignBlocks.length, 0);
  });

  it('arbitrary solid or foreign block at blueprint coordinate triggers foreignBlocks detection and rejects enclosure', () => {
    const center = { x: 10, y: 64, z: 20 };
    const bp = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt');
    const blocks = buildEnclosedBlocks(center, 'dirt');

    // Replace one wall block with a foreign chest or obsidian block
    blocks['11,64,20'] = { name: 'chest', boundingBox: 'block', position: new Vec3(11, 64, 20) };

    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      blocks,
    });

    const audit = auditEnclosure(bot, bp);
    assert.equal(audit.enclosed, false);
    assert.equal(audit.foreignBlocks.length, 1);
    assert.equal(audit.foreignBlocks[0].block, 'chest');
  });

  it('planner abandons blueprint site when foreign block occupies required coordinate during build', () => {
    const center = { x: 10, y: 64, z: 20 };
    const bp = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt');
    saveBlueprint(bp);

    // First coordinate in bp has an unexpected foreign crafting table
    const firstCoord = bp.requiredCoordinates[0];
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      items: [{ name: 'dirt', count: 30 }],
      blocks: {
        [`${firstCoord.x},${firstCoord.y},${firstCoord.z}`]: {
          name: 'crafting_table',
          boundingBox: 'block',
          position: new Vec3(firstCoord.x, firstCoord.y, firstCoord.z),
        },
      },
      time: { timeOfDay: 10500 },
    });

    const plan = GoalPlanner.planNextAction({ bot, goal: 'build_shelter' });
    assert.equal(plan.status, 'failed');
    assert.equal(plan.reason, 'foreign_block_in_shelter_footprint');

    const updatedBp = loadBlueprint();
    assert.equal(updatedBp.buildState, 'abandoned');
    clearBlueprint();
  });
});

describe('Stage 3D — Daytime Reserve Preemption (Clarification 4)', () => {
  it('calculates expendable building blocks accurately (dirt + cobblestone minus 3 reserved)', () => {
    const items = [
      { name: 'dirt', count: 10 },
      { name: 'cobblestone', count: 5 }, // 5 - 3 = 2 expendable
      { name: 'oak_planks', count: 20 },  // planks not expendable
      { name: 'sand', count: 15 },        // gravity block not expendable
    ];
    assert.equal(getExpendableBuildingBlocks(items), 12);
  });

  it('calculates latest safe gathering start based on material deficit', () => {
    // 25 needed, 10 present -> 15 deficit -> 15 * 120 = 1800 ticks -> 10000 - 1800 = 8200
    const items = [{ name: 'dirt', count: 10 }];
    const latestStart = getLatestSafeGatherStart(items);
    assert.equal(latestStart, 8200);
  });

  it('interrupts ordinary progression when timeOfDay >= latestSafeStart and materials deficient', async () => {
    // Starting at timeOfDay = 8500 (>= latestSafeStart 8200), only 10 dirt in inventory
    const bot = createMockBot({
      items: [{ name: 'dirt', count: 10 }],
      time: { timeOfDay: 8500, day: 1 },
    });

    const events = [];
    const manager = new ActionManager({ bot, getState: () => ({ active: true, ready: true }), telemetry: { emit: e => events.push(e) } });
    const controller = new SurvivalController({
      bot,
      actionManager: manager,
      primitives: {},
      telemetry: { emit: e => events.push(e) },
    });

    await controller.start('wooden_pickaxe');
    await new Promise((r) => setTimeout(r, 50));

    // Goal was suspended on stack, current goal switched to maintain_building_reserve
    assert.equal(controller.currentGoal, 'maintain_building_reserve');
    assert.equal(controller.goalStack.length, 1);
    assert.equal(controller.goalStack[0].goal, 'wooden_pickaxe');
    assert.equal(controller.goalStack[0].trigger, 'reserve_preemption');

    const suspendedEvent = events.find(e => e.event === 'controller_goal_suspended');
    assert.ok(suspendedEvent);
    assert.equal(suspendedEvent.trigger, 'reserve_preemption');
    assert.equal(suspendedEvent.newGoal, 'maintain_building_reserve');
    await controller.stop();
  });
});

describe('Stage 3D — Deadline-Failure Behavior (Clarification 5)', () => {
  beforeEach(() => clearBlueprint());
  afterEach(() => clearBlueprint());

  it('fails with shelter_deadline_missed when timeOfDay >= 12000 and shelter incomplete', () => {
    const bot = createMockBot({
      time: { timeOfDay: 12100 }, // past deadline
    });

    const plan = GoalPlanner.planNextAction({ bot, goal: 'build_shelter' });
    assert.equal(plan.status, 'failed');
    assert.equal(plan.reason, 'shelter_deadline_missed');
  });

  it('controller enters explicit failed_unsafe state, ceases safety claim, and abandons blueprint', async () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    saveBlueprint(bp);

    const bot = createMockBot({
      time: { timeOfDay: 12200 },
    });

    const events = [];
    const manager = new ActionManager({ bot, getState: () => ({ active: true, ready: true }), telemetry: { emit: e => events.push(e) } });
    const controller = new SurvivalController({
      bot,
      actionManager: manager,
      primitives: {},
      telemetry: { emit: e => events.push(e) },
    });

    await controller.start('build_shelter');
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(controller.shelterSafetyClaim, false);
    assert.equal(controller.status, 'failed_unsafe');
    assert.equal(controller.currentGoal, 'failed_unsafe');
    assert.equal(controller.active, true); // Stays active to preserve observation & emergency eating

    const failureEvent = events.find(e => e.event === 'controller_failure');
    assert.ok(failureEvent);
    assert.equal(failureEvent.status, 'failed_unsafe');
    assert.equal(failureEvent.reason, 'shelter_deadline_missed');
    assert.equal(failureEvent.safetyClaim, false);

    const saved = loadBlueprint();
    assert.equal(saved.buildState, 'abandoned');

    // External shutdown cleanly halts the emergency loop
    await controller.stop('external_shutdown');
    assert.equal(controller.active, false);
    assert.equal(controller.status, 'external_shutdown');
  });
});

describe('Stage 3D — Pre-Exit Safety & Dawn Exit Clearance', () => {
  beforeEach(() => clearBlueprint());
  afterEach(() => clearBlueprint());

  it('delays doorway clearance when hostile threat is within 8m of exit', () => {
    const center = { x: 10, y: 64, z: 20 };
    const exitDirection = { x: 0, y: 0, z: 1 };
    const bp = createShelterBlueprint(center, exitDirection, 'dirt');
    bp.buildState = 'waiting';
    saveBlueprint(bp);

    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      time: { timeOfDay: 23100 }, // Dawn
      entities: {
        'threat-1': {
          id: 50,
          name: 'creeper',
          position: new Vec3(10, 64, 24), // 2 blocks outside exit
        },
      },
    });

    const safety = checkExitSafety(bot, bp);
    assert.equal(safety.safe, false);
    assert.ok(safety.reason.includes('hostile_threat'));

    const plan = GoalPlanner.planNextAction({ bot, goal: 'leave_shelter' });
    assert.equal(plan.status, 'waiting');
    assert.ok(plan.reason.includes('hostile_threat'));
  });

  it('plans collection-optional doorway clearance (upper block then lower block) at dawn', () => {
    const center = { x: 10, y: 64, z: 20 };
    const exitDirection = { x: 0, y: 0, z: 1 };
    const bp = createShelterBlueprint(center, exitDirection, 'dirt');
    bp.buildState = 'waiting';
    saveBlueprint(bp);

    // Sealed doorway: upper block (10, 65, 21) and lower block (10, 64, 21) are dirt
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      time: { timeOfDay: 23500 }, // Full dawn
      blocks: {
        '10,65,21': { name: 'dirt', boundingBox: 'block', position: new Vec3(10, 65, 21) },
        '10,64,21': { name: 'dirt', boundingBox: 'block', position: new Vec3(10, 64, 21) },
        '10,63,22': { name: 'dirt', boundingBox: 'block', position: new Vec3(10, 63, 22) }, // safe landing footing
      },
    });

    // Step 1: clear upper doorway block with collectionOptional: true
    const plan1 = GoalPlanner.planNextAction({ bot, goal: 'leave_shelter' });
    assert.equal(plan1.status, 'action_required');
    assert.equal(plan1.action, 'gather');
    assert.deepEqual(plan1.args[0], { x: 10, y: 65, z: 21, layer: 1, expectedMaterial: 'dirt' });
    assert.equal(plan1.args[1].collectionOptional, true);
  });
});

describe('Stage 3D — Independent Identity Field Validation (Request 3)', () => {
  beforeEach(() => clearBlueprint());
  afterEach(() => clearBlueprint());

  it('rejects blueprint when server identity mismatches', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt', {
      server: 'mc.example.com:25565',
      dimension: 'overworld',
      worldId: 'world-1',
      mcVersion: '1.20',
    });
    saveBlueprint(bp);

    const bot = createMockBot({ playerPos: new Vec3(10.5, 64, 20.5) });
    const valid = validateBlueprintIdentity(bp, bot, { server: 'different.server.net:25565' });
    assert.equal(valid, false);
    assert.equal(bp.buildState, 'abandoned');
  });

  it('rejects blueprint when worldId mismatches', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt', {
      server: 'localhost:25565',
      dimension: 'overworld',
      worldId: 'world-alpha',
      mcVersion: '1.20',
    });
    saveBlueprint(bp);

    const bot = createMockBot({ playerPos: new Vec3(10.5, 64, 20.5) });
    const valid = validateBlueprintIdentity(bp, bot, { worldId: 'world-beta' });
    assert.equal(valid, false);
    assert.equal(bp.buildState, 'abandoned');
  });

  it('rejects blueprint when dimension mismatches', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt', {
      server: 'localhost:25565',
      dimension: 'overworld',
      worldId: 'world-1',
      mcVersion: '1.20',
    });
    saveBlueprint(bp);

    const bot = createMockBot({ playerPos: new Vec3(10.5, 64, 20.5) });
    const valid = validateBlueprintIdentity(bp, bot, { dimension: 'the_nether' });
    assert.equal(valid, false);
    assert.equal(bp.buildState, 'abandoned');
  });

  it('rejects blueprint when minecraft version mismatches', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt', {
      server: 'localhost:25565',
      dimension: 'overworld',
      worldId: 'world-1',
      mcVersion: '1.19.4',
    });
    saveBlueprint(bp);

    const bot = createMockBot({ playerPos: new Vec3(10.5, 64, 20.5) });
    const valid = validateBlueprintIdentity(bp, bot, { mcVersion: '1.20.1' });
    assert.equal(valid, false);
    assert.equal(bp.buildState, 'abandoned');
  });
});

describe('Stage 3D — Restart, Reconnect, Cancellation, Death & Corrupt Persistence Recovery (Request 2)', () => {
  beforeEach(() => clearBlueprint());
  afterEach(() => clearBlueprint());

  it('restart during partial construction loads verified coordinates and plans next remaining block', () => {
    const center = { x: 10, y: 64, z: 20 };
    const exitDirection = { x: 0, y: 0, z: 1 };
    const bp = createShelterBlueprint(center, exitDirection, 'dirt', {
      server: 'localhost:25565',
      dimension: 'overworld',
      worldId: 'world-1',
      mcVersion: '1.20',
    });
    bp.buildState = 'building';

    // Simulate 7 lower wall blocks already verified
    const lowerCoords = bp.requiredCoordinates.filter(c => c.phase === 'lower_walls');
    for (const c of lowerCoords) {
      bp.verifiedCoordinates.push(`${c.x},${c.y},${c.z}`);
      c.verified = true;
    }
    saveBlueprint(bp);

    // Bot standing at center with plenty of dirt
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      items: [{ name: 'dirt', count: 20 }],
    });

    // New controller / planning process queries next action
    const plan = GoalPlanner.planNextAction({ bot, goal: 'build_shelter' });
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'place');
    // Block 8 is the first upper wall block (phase: upper_walls)
    assert.equal(plan.details.phase, 'upper_walls');
    assert.equal(plan.details.blockIndex, 8);
    assert.equal(plan.args[1], 65); // cy + 1 = 65
  });

  it('reconnect in same world and dimension passes identity validation and keeps blueprint active', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt', {
      server: 'localhost:25565',
      dimension: 'overworld',
      worldId: 'world-1',
      mcVersion: '1.20',
    });
    bp.buildState = 'building';
    saveBlueprint(bp);

    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
    });

    const valid = validateBlueprintIdentity(bp, bot, {
      server: 'localhost:25565',
      dimension: 'overworld',
      worldId: 'world-1',
      mcVersion: '1.20',
    });
    assert.equal(valid, true);
    assert.equal(bp.buildState, 'building');
  });

  it('death abandons blueprint state', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    bp.buildState = 'building';
    saveBlueprint(bp);

    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      health: 0,
    });
    bot.entity.health = 0;

    const valid = validateBlueprintIdentity(bp, bot);
    assert.equal(valid, false);
    assert.equal(bp.buildState, 'abandoned');
  });

  it('remote respawn > 64m abandons blueprint state', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    bp.buildState = 'building';
    saveBlueprint(bp);

    const bot = createMockBot({
      playerPos: new Vec3(500, 64, 500), // > 64m away
    });

    const valid = validateBlueprintIdentity(bp, bot);
    assert.equal(valid, false);
    assert.equal(bp.buildState, 'abandoned');
  });

  it('handles corrupt or incomplete persistence files by discarding and falling back to clean plan', () => {
    const bpFile = process.env.SHELTER_BLUEPRINT_PATH;
    // Corrupt JSON
    fs.writeFileSync(bpFile, '{"incomplete": ', 'utf8');
    assert.equal(loadBlueprint(), null);

    // Incomplete schema (missing center or requiredCoordinates)
    fs.writeFileSync(bpFile, '{"server": "localhost"}', 'utf8');
    assert.equal(loadBlueprint(), null);

    // Planner with corrupt file safely ignores it and evaluates fresh safe site
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      items: [{ name: 'dirt', count: 30 }],
      blocks: {},
    });
    // Add floor and air blocks for site evaluation around (10, 64, 20)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        bot.blocks[`${10 + dx},63,${20 + dz}`] = { name: 'dirt', boundingBox: 'block' };
        bot.blocks[`${10 + dx},64,${20 + dz}`] = { name: 'air', boundingBox: 'empty' };
        bot.blocks[`${10 + dx},65,${20 + dz}`] = { name: 'air', boundingBox: 'empty' };
        bot.blocks[`${10 + dx},66,${20 + dz}`] = { name: 'air', boundingBox: 'empty' };
      }
    }
    bot.blocks['10,63,22'] = { name: 'dirt', boundingBox: 'block' };
    bot.blocks['10,64,22'] = { name: 'air', boundingBox: 'empty' };
    bot.blocks['10,65,22'] = { name: 'air', boundingBox: 'empty' };

    const plan = GoalPlanner.planNextAction({ bot, goal: 'build_shelter' });
    assert.notEqual(plan.status, 'failed');
    const fresh = loadBlueprint();
    assert.ok(fresh);
    assert.ok(fresh.center);
    assert.equal(fresh.requiredCoordinates.length, 25);
  });
});

describe('Stage 3D — Failure Paths & Unsafe Exit Scenarios (Request 5)', () => {
  beforeEach(() => clearBlueprint());
  afterEach(() => clearBlueprint());

  it('fails with no_safe_site when surrounding area is all hazards/lava', () => {
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      items: [{ name: 'dirt', count: 30 }],
      blockAt: () => ({ name: 'lava', boundingBox: 'empty' }),
    });

    const plan = GoalPlanner.planNextAction({ bot, goal: 'build_shelter' });
    assert.equal(plan.status, 'failed');
    assert.equal(plan.reason, 'no_safe_site');
  });

  it('fails with shelter_deadline_missed when timeOfDay >= 12000 during partial build', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    bp.buildState = 'building';
    bp.verifiedCoordinates = ['10,64,19', '11,64,19', '11,64,20', '11,64,21', '9,64,21'];
    saveBlueprint(bp);

    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      time: { timeOfDay: 12500 }, // Past deadline
    });

    const plan = GoalPlanner.planNextAction({ bot, goal: 'build_shelter' });
    assert.equal(plan.status, 'failed');
    assert.equal(plan.reason, 'shelter_deadline_missed');

    const saved = loadBlueprint();
    assert.equal(saved.buildState, 'abandoned');
  });

  it('detects fluid outside exit doorway (water/lava)', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      blocks: {
        '10,63,22': { name: 'lava', boundingBox: 'empty' },
      },
    });

    const safety = checkExitSafety(bot, bp);
    assert.equal(safety.safe, false);
    assert.ok(safety.reason.includes('unsafe_outside_footing') || safety.reason.includes('fluid'));
  });

  it('detects unsafe footing (air/void/cliff) outside exit landing', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      blocks: {
        '10,63,22': { name: 'air', boundingBox: 'empty' },
      },
    });

    const safety = checkExitSafety(bot, bp);
    assert.equal(safety.safe, false);
    assert.equal(safety.reason, 'unsafe_outside_footing');
  });

  it('detects entity obstruction standing directly in exit doorway', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      blocks: {
        '10,63,22': { name: 'dirt', boundingBox: 'block' },
        '10,64,22': { name: 'air', boundingBox: 'empty' },
        '10,65,22': { name: 'air', boundingBox: 'empty' },
      },
      entities: {
        'cow-1': {
          id: 99,
          name: 'cow',
          position: new Vec3(10.2, 64, 22.1),
        },
      },
    });

    const safety = checkExitSafety(bot, bp);
    assert.equal(safety.safe, false);
    assert.equal(safety.reason, 'entity_obstruction_at_exit');
  });

  it('collection-optional doorway removal succeeds with block_cleared even when inventory is full', async () => {
    const world = {
      '10,65,21': { name: 'dirt', position: { x: 10, y: 65, z: 21 }, boundingBox: 'block' },
    };

    const bot = {
      entity: { position: { x: 10.5, y: 64, z: 20.5 } },
      blockAt: (pos) => world[`${pos.x},${pos.y},${pos.z}`] || { name: 'air' },
      canDigBlock: () => true,
      dig: async () => {
        delete world['10,65,21'];
      },
      stopDigging: () => {},
      pathfinder: {
        setMovements: () => {},
        goto: async () => {},
      },
      inventory: {
        items: () => new Array(36).fill({ name: 'cobblestone', count: 64, stackSize: 64 }),
        emptySlotCount: () => 0,
      },
    };

    const actionManager = new ActionManager({
      bot,
      getState: () => ({ active: true, ready: true, sessionId: 1 }),
      telemetry: { emit: () => {} },
    });

    const { createGatherer } = require('../src/actions/gather');
    const gatherer = createGatherer(bot, actionManager);
    const result = await gatherer.gather({ x: 10, y: 65, z: 21 }, { collectionOptional: true });

    assert.equal(result.outcome, 'success');
    assert.equal(result.reason, 'block_cleared');
    assert.equal(world['10,65,21'], undefined);
  });
});

describe('Stage 3D — Emergency Behavior Preservation in failed_unsafe (Request 6)', () => {
  beforeEach(() => clearBlueprint());
  afterEach(() => clearBlueprint());

  it('preserves emergency eating and observation in failed_unsafe mode', async () => {
    const events = [];
    let eatenItem = null;

    const bot = createMockBot({
      food: 10,
      items: [{ name: 'bread', count: 3 }],
    });

    const manager = new ActionManager({
      bot,
      getState: () => ({ active: true, ready: true }),
      telemetry: { emit: e => events.push(e) },
    });

    const controller = new SurvivalController({
      bot,
      actionManager: manager,
      primitives: {
        eater: {
          eat: async (foodName) => {
            eatenItem = foodName;
            bot.food = 15;
            return { outcome: 'success', reason: 'ate_food' };
          },
        },
      },
      telemetry: { emit: e => events.push(e) },
    });

    controller.status = 'failed_unsafe';
    controller.currentGoal = 'failed_unsafe';
    controller.active = true;
    controller.currentRunId = 'run-failed-emergency';

    await controller._tick('run-failed-emergency');

    assert.equal(eatenItem, 'bread');
    assert.equal(controller.shelterSafetyClaim, false);

    const obsTick = events.find(e => e.event === 'controller_observation_tick');
    assert.ok(obsTick);
    assert.equal(obsTick.status, 'failed_unsafe');
    assert.equal(obsTick.safetyClaim, false);

    await controller.stop('external_halt');
    assert.equal(controller.active, false);
    assert.equal(controller.status, 'external_halt');
  });
});

describe('Stage 3D — Night Eating inside Enclosure (Request 7)', () => {
  beforeEach(() => clearBlueprint());
  afterEach(() => clearBlueprint());

  it('eats safe food when food <= 14 during wait_out_night without damaging shelter', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    bp.buildState = 'waiting';
    saveBlueprint(bp);

    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      time: { timeOfDay: 15000 },
      food: 12,
      items: [
        { name: 'bread', count: 2 },
        { name: 'dirt', count: 10 },
      ],
    });

    const plan = GoalPlanner.planNextAction({ bot, goal: 'wait_out_night' });
    assert.equal(plan.status, 'action_required');
    assert.equal(plan.action, 'eat');
    assert.equal(plan.args[0], 'bread');
    assert.equal(plan.reason, 'eat_while_sheltered');
  });

  it('waits safely when food > 14 during wait_out_night', () => {
    const bp = createShelterBlueprint({ x: 10, y: 64, z: 20 }, { x: 0, y: 0, z: 1 }, 'dirt');
    bp.buildState = 'waiting';
    saveBlueprint(bp);

    const bot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      time: { timeOfDay: 15000 },
      food: 20,
      items: [{ name: 'bread', count: 2 }],
    });

    const plan = GoalPlanner.planNextAction({ bot, goal: 'wait_out_night' });
    assert.equal(plan.status, 'waiting');
    assert.equal(plan.reason, 'waiting_for_daylight');
  });
});

