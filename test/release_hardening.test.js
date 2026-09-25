'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');

const { FailureTracker } = require('../src/controller/failure_tracker');
const { GoalPlanner } = require('../src/controller/planner');
const { SurvivalController, findSafeFleeDestination } = require('../src/controller/survival_controller');
const { ActionManager } = require('../src/actions/manager');
const {
  checkExitSafety,
  loadBlueprint,
  saveBlueprint,
  validateBlueprintIdentity,
  createShelterBlueprint,
  RANGED_HOSTILES,
  MELEE_HOSTILES,
  ALL_HOSTILES,
} = require('../src/actions/shelter');

// ---------------------------------------------------------------------------
// Helpers and Mocks
// ---------------------------------------------------------------------------

function createMockBot(overrides = {}) {
  const inventoryItems = overrides.items || [];
  const entitiesMap = overrides.entities || {};

  return {
    entity: {
      position: overrides.playerPos || new Vec3(0, 64, 0),
      health: overrides.health ?? 20,
    },
    health: overrides.health ?? 20,
    food: overrides.food ?? 20,
    foodSaturation: overrides.foodSaturation ?? 5,
    entities: entitiesMap,
    inventory: {
      items: () => inventoryItems,
    },
    registry: {
      blocksByName: {
        dirt: { id: 3, name: 'dirt' },
        grass_block: { id: 2, name: 'grass_block' },
        stone: { id: 1, name: 'stone' },
        air: { id: 0, name: 'air' },
      },
    },
    blockAt: overrides.blockAt || ((pos) => {
      if (pos.y < 64) {
        return {
          name: 'dirt',
          boundingBox: 'block',
          position: new Vec3(pos.x, pos.y, pos.z),
        };
      }
      return {
        name: 'air',
        boundingBox: 'empty',
        position: new Vec3(pos.x, pos.y, pos.z),
      };
    }),
    findBlock: overrides.findBlock || (() => null),
    time: overrides.time || { timeOfDay: 1000, age: 5000 },
    on: () => {},
    removeListener: () => {},
    _client: overrides._client || {
      socket: { remoteAddress: '127.0.0.1', remotePort: 55555 },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('P0-1: FailureTracker resets run budget on controller.start() and stops budget leakage', async () => {
  const tracker = new FailureTracker({ maxDispatchedActions: 500, maxDispatchedPerGoal: 150 });
  const mockBot = createMockBot();
  const controller = new SurvivalController({
    bot: mockBot,
    failureTracker: tracker,
  });

  // Simulate prior run that consumed budget and achieved milestones
  tracker.incrementDispatchedActions('test_goal');
  tracker.incrementDispatchedActions('test_goal');
  assert.equal(tracker.getDispatchedActions(), 2);
  assert.equal(tracker.getDispatchedActionsForGoal('test_goal'), 2);

  controller.milestones.woodenPickaxeAchieved = true;
  controller._recordedMilestones.add('wooden_pickaxe');
  controller._shelteredTickCount = 42;

  // Starting a new run must reset run-scoped budget and milestone state
  await controller.start('wooden_pickaxe', { dryRun: 'step' });

  assert.equal(tracker.getDispatchedActions(), 0);
  assert.equal(tracker.getDispatchedActionsForGoal('test_goal'), 0);
  assert.equal(controller.milestones.woodenPickaxeAchieved, false);
  assert.equal(controller._recordedMilestones.has('wooden_pickaxe'), false);
  assert.equal(controller._shelteredTickCount, 0);
});

test('P1-1: findSafeFleeDestination returns null when all candidates are hazardous and controller does not navigate', async () => {
  const botPos = new Vec3(10, 64, 10);
  const threatPos = new Vec3(10, 64, 15);

  // Bot surrounded by lava floor
  const mockBot = createMockBot({
    playerPos: botPos,
    blockAt: (pos) => {
      return {
        name: 'lava',
        boundingBox: 'empty',
        position: new Vec3(pos.x, pos.y, pos.z),
      };
    },
  });

  const threats = [{ position: threatPos, name: 'skeleton' }];
  const safeTarget = findSafeFleeDestination(mockBot, threats, 12, 18);

  // Must return null instead of an unvalidated coordinate
  assert.equal(safeTarget, null);
});

test('P1-2: Shelter breach during night transitions controller to failed_unsafe and blocks night_survived', () => {
  const mockBot = createMockBot({
    time: { timeOfDay: 18000, age: 10000 },
  });

  const controller = new SurvivalController({
    bot: mockBot,
    failureTracker: new FailureTracker(),
  });

  controller.active = true;
  controller.status = 'running';
  controller.currentGoal = 'wait_out_night';
  controller.shelterSafetyClaim = true;

  // Trigger breach during night
  controller._handleShelterBreach(new Vec3(0, 64, 0), 'block_broken_during_night', 'test-run');

  assert.equal(controller.shelterSafetyClaim, false);
  assert.equal(controller.breachDetected, true);
  assert.equal(controller.status, 'failed_unsafe');
  assert.equal(controller.active, false);

  // Recording night_survived must be suppressed
  controller._recordMilestone('night_survived', 'test-run');
  assert.equal(controller.milestones.nightSurvived, false);
});

test('P1-3: checkExitSafety rejects exit when ranged mob is within 16m or solid block obstructs exterior', () => {
  const center = new Vec3(0, 64, 0);
  const bp = createShelterBlueprint(center, { x: 1, y: 0, z: 0 });

  // Case A: Pillager at 14m
  const botWithPillager = createMockBot({
    playerPos: center,
    entities: {
      1: {
        name: 'pillager',
        position: new Vec3(14, 64, 0),
      },
    },
  });
  const resPillager = checkExitSafety(botWithPillager, bp, { x: 1, y: 0, z: 0 });
  assert.equal(resPillager.safe, false);
  assert.match(resPillager.reason, /hostile_threat_pillager_at_exit/);

  // Case B: Stray at 12m
  const botWithStray = createMockBot({
    playerPos: center,
    entities: {
      2: {
        name: 'stray',
        position: new Vec3(12, 64, 0),
      },
    },
  });
  const resStray = checkExitSafety(botWithStray, bp, { x: 1, y: 0, z: 0 });
  assert.equal(resStray.safe, false);
  assert.match(resStray.reason, /hostile_threat_stray_at_exit/);

  // Case C: Solid stone block directly in doorway exterior clearance
  const botWithObstruction = createMockBot({
    playerPos: center,
    blockAt: (pos) => {
      // Exterior doorway clearance at (center.x + 2, center.y, center.z)
      if (pos.x === 2 && pos.y === 64 && pos.z === 0) {
        return { name: 'stone', boundingBox: 'block', position: new Vec3(2, 64, 0) };
      }
      if (pos.y < 64) {
        return { name: 'dirt', boundingBox: 'block', position: new Vec3(pos.x, pos.y, pos.z) };
      }
      return { name: 'air', boundingBox: 'empty', position: new Vec3(pos.x, pos.y, pos.z) };
    },
  });
  const resObs = checkExitSafety(botWithObstruction, bp, { x: 1, y: 0, z: 0 });
  assert.equal(resObs.safe, false);
  assert.match(resObs.reason, /solid_obstruction_outside_exit_stone/);
});

test('P1-4: ActionManager keeps single-flight lock until ignored-abort execution settles', async () => {
  const mockBot = createMockBot();
  const manager = new ActionManager({
    bot: mockBot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: () => {} },
  });
  let slowExecutionFinished = false;

  // Action that ignores abort signal and continues running for 120ms
  const actionPromise = manager.run('slow_action', { x: 0, y: 0, z: 0 }, 30, async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    slowExecutionFinished = true;
    return { outcome: 'success' };
  });

  // Wait 50ms: timeout (30ms) has occurred, but execution (120ms) is still in progress
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(slowExecutionFinished, false, 'Execution should still be running at 50ms');

  // Single-flight lock must still be active
  assert.equal(manager.isBusy, true, 'Manager must remain busy while slow action continues');

  // Attempting to dispatch another action must fail because manager is locked
  const secondAttempt = await manager.run('second_action', { x: 0, y: 0, z: 0 }, 5000, async () => ({ outcome: 'success' }));
  assert.equal(secondAttempt.outcome, 'failed');
  assert.equal(secondAttempt.reason, 'action_in_flight');

  // Now await the original action to settle completely
  const res = await actionPromise;
  assert.equal(res.outcome, 'timed_out');
  assert.equal(slowExecutionFinished, true, 'Execution must have completed');

  // Now manager should be idle and accept new actions
  assert.equal(manager.isBusy, false);
  const secondResult = await manager.run('second_action', { x: 0, y: 0, z: 0 }, 5000, async () => ({ outcome: 'success' }));
  assert.equal(secondResult.outcome, 'success');
});

test('P1-5: Corrupt blueprint file on disk is quarantined to .corrupt-* and clean state returned', () => {
  const tmpBpFile = path.join(process.cwd(), `.test_bp_${Date.now()}.json`);
  process.env.SHELTER_BLUEPRINT_PATH = tmpBpFile;

  try {
    // Write invalid corrupt JSON to blueprint file
    fs.writeFileSync(tmpBpFile, '{ corrupt json content: invalid !!! }', 'utf8');

    const loaded = loadBlueprint();
    assert.equal(loaded, null);

    // The corrupt file must have been quarantined (renamed to .corrupt-*)
    assert.equal(fs.existsSync(tmpBpFile), false);

    const dirFiles = fs.readdirSync(process.cwd());
    const quarantined = dirFiles.filter((f) => f.startsWith(path.basename(tmpBpFile) + '.corrupt-'));
    assert.ok(quarantined.length >= 1, 'Expected quarantined corrupt file');

    // Clean up quarantined file
    for (const q of quarantined) {
      try { fs.unlinkSync(path.join(process.cwd(), q)); } catch {}
    }
  } finally {
    delete process.env.SHELTER_BLUEPRINT_PATH;
    try { if (fs.existsSync(tmpBpFile)) fs.unlinkSync(tmpBpFile); } catch {}
  }
});

test('P1-5: validateBlueprintIdentity separates LAN worlds by port', () => {
  const center = new Vec3(0, 64, 0);
  const bp = createShelterBlueprint(center, { x: 1, y: 0, z: 0 });
  bp.server = '127.0.0.1:55555';

  const botPortA = createMockBot({
    playerPos: center,
    _client: { socket: { remoteAddress: '127.0.0.1', remotePort: 55555 } },
  });
  assert.equal(validateBlueprintIdentity(bp, botPortA), true);

  const botPortB = createMockBot({
    playerPos: center,
    _client: { socket: { remoteAddress: '127.0.0.1', remotePort: 61375 } },
  });
  // Different port on same IP must be rejected (different LAN world)
  assert.equal(validateBlueprintIdentity(bp, botPortB), false);
});

test('P1-6: Shelter planner returns no_safe_material_source when dirt exists only inside protected footprint', () => {
  const center = new Vec3(0, 64, 0);
  const bp = createShelterBlueprint(center, { x: 1, y: 0, z: 0 });

  const mockBot = createMockBot({
    playerPos: center,
    items: [], // No building blocks in inventory
    findBlock: () => null, // findBlock returns null because all candidate blocks are inside the 3x3 footprint
  });

  const plan = GoalPlanner.planNextAction({
    bot: mockBot,
    goal: 'build_shelter',
    currentBlueprint: bp,
    failureTracker: new FailureTracker(),
  });

  // Must return failed with no_safe_material_source instead of action_required for unvalidated generic 'dirt'
  assert.equal(plan.status, 'failed');
  assert.equal(plan.reason, 'no_safe_material_source');
});

test('Regression: pre-existing grass_block at shelter coordinate does not trigger foreign_block_in_shelter_footprint failure', () => {
  const center = new Vec3(10, 64, 20);
  const bp = createShelterBlueprint(center, { x: 0, y: 0, z: 1 }, 'dirt', {
    server: '127.0.0.1:55555',
    dimension: 'overworld',
  });
  const firstCoord = bp.requiredCoordinates[0];

  const tmpBpFile = path.join(process.cwd(), `.test_bp_grass_${Date.now()}.json`);
  process.env.SHELTER_BLUEPRINT_PATH = tmpBpFile;

  try {
    saveBlueprint(bp);

    const mockBot = createMockBot({
      playerPos: new Vec3(10.5, 64, 20.5),
      items: [{ name: 'dirt', count: 30 }],
      blockAt: (pos) => {
        if (pos.x === firstCoord.x && pos.y === firstCoord.y && pos.z === firstCoord.z) {
          return { name: 'grass_block', boundingBox: 'block', position: new Vec3(pos.x, pos.y, pos.z) };
        }
        return { name: 'air', boundingBox: null, position: new Vec3(pos.x, pos.y, pos.z) };
      },
      time: { timeOfDay: 10500 },
    });

    const plan = GoalPlanner.planNextAction({
      bot: mockBot,
      goal: 'build_shelter',
      currentBlueprint: bp,
      failureTracker: new FailureTracker(),
    });

    // grass_block must be accepted as an approved shelter material matching dirt, not rejected as foreign_block
    assert.notEqual(plan.status, 'failed');
    assert.notEqual(plan.reason, 'foreign_block_in_shelter_footprint');
  } finally {
    delete process.env.SHELTER_BLUEPRINT_PATH;
    try { if (fs.existsSync(tmpBpFile)) fs.unlinkSync(tmpBpFile); } catch {}
  }
});

