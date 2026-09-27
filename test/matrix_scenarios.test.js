'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Vec3 } = require('vec3');

const {
  SurvivalController,
  HEALTH_THRESHOLDS,
  findSafeFleeDestination,
} = require('../src/controller/survival_controller');
const { FailureTracker } = require('../src/controller/failure_tracker');
const {
  createShelterBlueprint,
  saveBlueprint,
  loadBlueprint,
  clearBlueprint,
  auditEnclosure,
} = require('../src/actions/shelter');

test('Matrix Scenario 1 — Early Ranged Hostile (Skeleton / Pillager at 16m)', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  let cancelledAction = null;
  const actionManager = {
    isBusy: true,
    currentAction: { actionName: 'gather' },
    cancel: (reason) => { cancelledAction = reason; },
    waitForIdle: async () => {},
  };

  // Skeleton at 15m distance (outside melee 10m, but inside ranged 16m threshold)
  const bot = {
    health: 20,
    food: 20,
    time: { timeOfDay: 3000, age: 500 },
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      10: {
        id: 10,
        name: 'skeleton',
        type: 'skeleton',
        position: new Vec3(15, 64, 0),
      },
    },
    inventory: { items: () => [] },
    on: () => {},
    removeListener: () => {},
  };

  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  controller.active = true;
  controller.currentRunId = 'ranged-test-run';
  controller.currentGoal = 'wooden_pickaxe';

  await controller._tick('ranged-test-run');

  assert.strictEqual(cancelledAction, 'hostile_threat_nearby', 'In-flight gathering must be cancelled by early ranged threat');
  assert.strictEqual(controller.currentGoal, 'flee_threat', 'Goal must switch to flee_threat');
  assert.strictEqual(controller.goalStack[0].goal, 'wooden_pickaxe', 'Original progression goal must be saved on stack');

  // Verify threat preemption event
  const preemption = events.find(e => e.event === 'controller_preemption' && e.reason === 'hostile_threat_nearby');
  assert.ok(preemption, 'Preemption telemetry event must be emitted');
});

test('Matrix Scenario 2 — Resource Scarcity Fallback (Sparse Trees / No Exposed Stone)', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  // Desert/badlands scenario: no trees or stone exposed nearby
  const bot = {
    health: 20,
    food: 20,
    heldItem: { name: 'wooden_pickaxe' },
    time: { timeOfDay: 2000, age: 1000 },
    entity: { position: new Vec3(100, 64, 100) },
    entities: {},
    inventory: {
      items: () => [{ name: 'wooden_pickaxe', count: 1 }, { name: 'dirt', count: 12 }], // Has wooden pickaxe, but deficient building reserve (< 30) and no exposed stone
    },
    registry: {
      blocksByName: { stone: { id: 1 }, dirt: { id: 3 } },
      itemsByName: { cobblestone: { id: 2 } },
    },
    findBlock: () => null,
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = { isBusy: false, cancel: () => {}, waitForIdle: async () => {} };
  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  controller.active = true;
  controller.currentRunId = 'scarcity-run';
  controller.currentGoal = 'stone_pickaxe';

  await controller._tick('scarcity-run');

  // Should transition to maintain_building_reserve instead of stalling
  assert.strictEqual(controller.currentGoal, 'maintain_building_reserve', 'When stone/wood unavailable, must fall back to building reserve gathering');
  const goalSwitched = events.find(e => e.event === 'controller_goal_switched' && e.to === 'maintain_building_reserve');
  assert.ok(goalSwitched, 'Goal switched telemetry event must be emitted');
});

test('Matrix Scenario 3 — Pause / Restart Recovery', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  const bot = {
    health: 19,
    food: 18,
    time: { timeOfDay: 4500, age: 3000 },
    entity: { position: new Vec3(50, 64, 50) },
    entities: {},
    inventory: {
      items: () => [
        { name: 'wooden_pickaxe', count: 1 },
        { name: 'dirt', count: 35 },
      ],
    },
    on: () => {},
    removeListener: () => {},
  };

  let wasCancelled = false;
  const actionManager = {
    isBusy: true,
    currentAction: { actionName: 'gather' },
    cancel: () => { wasCancelled = true; },
    waitForIdle: async () => {},
  };

  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  await controller.start('stone_pickaxe');
  assert.strictEqual(controller.active, true);
  assert.strictEqual(controller.status, 'running');

  // Simulate operator pause
  await controller.stop('paused');
  assert.strictEqual(controller.active, false);
  assert.strictEqual(controller.status, 'paused');
  assert.strictEqual(wasCancelled, true, 'Active action must be cancelled on pause');

  // Restart controller in fresh run
  await controller.start('stone_pickaxe');
  assert.strictEqual(controller.active, true);
  assert.strictEqual(controller.status, 'running');
  assert.strictEqual(controller.generation, 2, 'Generation token must increment across restarts');

  await controller.stop('test_complete');
});

test('Matrix Scenario 4 — Controlled Shelter Breach Recovery (Instant Night Breach -> failed_unsafe)', async () => {
  const events = [];
  const telemetry = { emit: (e) => events.push(e) };
  const failureTracker = new FailureTracker();

  const center = new Vec3(20, 64, 20);
  const bp = createShelterBlueprint(center, 'dirt', {
    server: 'localhost:61375',
    worldId: 'matrix-world',
    dimension: 'overworld',
    minecraftVersion: '1.21',
  });
  bp.buildState = 'waiting';
  saveBlueprint(bp);

  const bot = {
    health: 20,
    food: 20,
    time: { timeOfDay: 14000, age: 8000 }, // Night time (14000)
    entity: { position: new Vec3(20.5, 64, 20.5) },
    entities: {},
    inventory: { items: () => [{ name: 'dirt', count: 5 }] },
    on: () => {},
    removeListener: () => {},
  };

  const actionManager = { isBusy: false, cancel: () => {}, waitForIdle: async () => {} };
  const controller = new SurvivalController({
    bot,
    actionManager,
    telemetry,
    failureTracker,
  });

  controller.active = true;
  controller.currentRunId = 'breach-run';
  controller.currentGoal = 'wait_out_night';
  controller.shelterSafetyClaim = true;

  // Simulate block broken in shelter wall at night
  const breachPos = new Vec3(21, 64, 20);
  controller._handleShelterBreach(breachPos, 'creeper_explosion', 'breach-run');

  assert.strictEqual(controller.shelterSafetyClaim, false, 'Shelter safety claim must be revoked on breach');
  assert.strictEqual(controller.breachDetected, true, 'breachDetected must be true');
  assert.strictEqual(controller.status, 'failed_unsafe', 'Night breach must transition to failed_unsafe');
  assert.strictEqual(controller.active, false, 'Controller must halt active progression');

  // Verify blueprint was updated to remove broken coordinate
  const updatedBp = loadBlueprint();
  const hasBreachCoord = updatedBp.verifiedCoordinates.includes(`${breachPos.x},${breachPos.y},${breachPos.z}`);
  assert.strictEqual(hasBreachCoord, false, 'Breached coordinate must be removed from verified coordinates');

  clearBlueprint();
});
