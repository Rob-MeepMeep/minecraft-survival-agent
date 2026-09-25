'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNavigationArgs,
  distance3D,
  createSafeMovements,
  DEFAULT_ARRIVAL_TOLERANCE,
} = require('../src/actions/navigate');
const { ActionManager } = require('../src/actions/manager');

// ---------------------------------------------------------------------------
// 1. Argument Parsing & Coordinate Validation Tests
// ---------------------------------------------------------------------------

test('parseNavigationArgs — valid absolute 3D coordinates', () => {
  const parsed = parseNavigationArgs(['10', '65', '-20'], { x: 0, y: 64, z: 0 });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.target, {
    x: 10,
    y: 65,
    z: -20,
    range: 1,
    requestedRange: 1,
    arrivalTolerance: DEFAULT_ARRIVAL_TOLERANCE,
    maxAcceptableDistance: 1.5,
  });
  assert.equal(parsed.timeoutMs, 30000);
});

test('parseNavigationArgs — 2D coordinates defaults y to current position', () => {
  const parsed = parseNavigationArgs(['15', '-30'], { x: 0, y: 72, z: 0 });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.target, {
    x: 15,
    y: 72,
    z: -30,
    range: 1,
    requestedRange: 1,
    arrivalTolerance: DEFAULT_ARRIVAL_TOLERANCE,
    maxAcceptableDistance: 1.5,
  });
  assert.equal(parsed.timeoutMs, 30000);
});

test('parseNavigationArgs — relative coordinates ~dx ~dy ~dz', () => {
  const currentPos = { x: 100, y: 64, z: -50 };
  const parsed = parseNavigationArgs(['~5', '~-2', '~10'], currentPos);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.target, {
    x: 105,
    y: 62,
    z: -40,
    range: 1,
    requestedRange: 1,
    arrivalTolerance: DEFAULT_ARRIVAL_TOLERANCE,
    maxAcceptableDistance: 1.5,
  });
});

test('parseNavigationArgs — relative coordinate ~ with no offset means 0 offset', () => {
  const currentPos = { x: 10, y: 20, z: 30 };
  const parsed = parseNavigationArgs(['~', '~5', '~'], currentPos);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.target, {
    x: 10,
    y: 25,
    z: 30,
    range: 1,
    requestedRange: 1,
    arrivalTolerance: DEFAULT_ARRIVAL_TOLERANCE,
    maxAcceptableDistance: 1.5,
  });
});

test('parseNavigationArgs — custom range and timeout', () => {
  const parsed = parseNavigationArgs(['0', '64', '0', '3.5', '12'], { x: 0, y: 64, z: 0 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.target.requestedRange, 3.5);
  assert.equal(parsed.target.arrivalTolerance, 0.5);
  assert.equal(parsed.target.maxAcceptableDistance, 4);
  assert.equal(parsed.timeoutMs, 12000);
});

test('parseNavigationArgs — rejection cases', () => {
  // Empty arguments
  assert.equal(parseNavigationArgs([], { x: 0, y: 0, z: 0 }).ok, false);

  // Single argument (insufficient)
  assert.equal(parseNavigationArgs(['10'], { x: 0, y: 0, z: 0 }).ok, false);

  // Non-numeric coordinates
  const nanParse = parseNavigationArgs(['abc', '64', '0'], { x: 0, y: 0, z: 0 });
  assert.equal(nanParse.ok, false);
  assert.match(nanParse.error, /Invalid numeric coordinate/);

  // Negative range
  const negRange = parseNavigationArgs(['0', '64', '0', '-2'], { x: 0, y: 0, z: 0 });
  assert.equal(negRange.ok, false);
  assert.match(negRange.error, /Invalid range/);

  // Invalid timeout
  const badTimeout = parseNavigationArgs(['0', '64', '0', '1', 'abc'], { x: 0, y: 0, z: 0 });
  assert.equal(badTimeout.ok, false);
  assert.match(badTimeout.error, /Invalid timeout/);
});

// ---------------------------------------------------------------------------
// 2. Distance Calculations
// ---------------------------------------------------------------------------

test('distance3D — computes 3D Euclidean distance', () => {
  assert.equal(distance3D({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
  assert.equal(distance3D({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 }), 3);
  assert.equal(distance3D(null, { x: 1, y: 2, z: 3 }), Infinity);
});

// ---------------------------------------------------------------------------
// 3. Movement Safety Configuration
// ---------------------------------------------------------------------------

test('createSafeMovements — disables digging and scaffolding', () => {
  const mcData = require('prismarine-registry')('1.20.4');
  const dummyBot = { registry: mcData };
  const movements = createSafeMovements(dummyBot);
  assert.equal(movements.canDig, false, 'canDig must be disabled for pure navigation');
  assert.equal(movements.scafoldingBlocks.length, 0, 'scaffolding blocks must be empty');
  assert.equal(movements.allow1by1towers, false, '1x1 towers must be disabled');
});

// ---------------------------------------------------------------------------
// 4. ActionManager Concurrency & Lifecycle
// ---------------------------------------------------------------------------

function createMockBot() {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      stopCalls: 0,
      goalCalls: 0,
      stop() { this.stopCalls++; },
      setGoal() { this.goalCalls++; },
    },
    clearControlStatesCalls: 0,
    clearControlStates() { this.clearControlStatesCalls++; },
  };
}

test('ActionManager — rejects action if agent not ready', async () => {
  const mockBot = createMockBot();
  const telemetryEvents = [];
  const manager = new ActionManager({
    bot: mockBot,
    getState: () => ({ active: false, ready: false, sessionId: 1 }),
    telemetry: { emit: (e) => telemetryEvents.push(e) },
  });

  const res = await manager.run('navigate', { x: 10, y: 64, z: 0 }, 1000, async () => ({}));
  assert.equal(res.outcome, 'failed');
  assert.equal(res.reason, 'agent_not_ready');
  assert.equal(manager.isBusy, false);
});

test('ActionManager — single-flight concurrency rejects second action', async () => {
  const mockBot = createMockBot();
  const telemetryEvents = [];
  const manager = new ActionManager({
    bot: mockBot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: (e) => telemetryEvents.push(e) },
  });

  let resolveFirst;
  const firstPromise = manager.run('navigate', { x: 10, y: 64, z: 0 }, 5000, () => {
    return new Promise((resolve) => {
      resolveFirst = resolve;
    });
  });

  // Second action while first is running:
  const secondRes = await manager.run('navigate', { x: 20, y: 64, z: 0 }, 1000, async () => ({}));
  assert.equal(secondRes.outcome, 'failed');
  assert.equal(secondRes.reason, 'action_in_flight');
  assert.match(secondRes.message, /already running/);

  // Complete first
  resolveFirst({ outcome: 'success', reason: 'reached_destination' });
  const firstRes = await firstPromise;
  assert.equal(firstRes.outcome, 'success');
  assert.equal(firstRes.actionId, 'action-1');
  assert.equal(manager.isBusy, false);
});

test('ActionManager — timeout cancels action and stops movement', async () => {
  const mockBot = createMockBot();
  const telemetryEvents = [];
  const manager = new ActionManager({
    bot: mockBot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: (e) => telemetryEvents.push(e) },
  });

  const res = await manager.run(
    'navigate',
    { x: 100, y: 64, z: 100 },
    50, // 50ms timeout
    async (signal) => {
      // Hang indefinitely unless aborted
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
  );

  assert.equal(res.outcome, 'timed_out');
  assert.match(res.reason, /Exceeded timeout of 50ms/);
  assert.equal(mockBot.pathfinder.stopCalls > 0, true);
  assert.equal(mockBot.clearControlStatesCalls > 0, true);
  assert.equal(manager.isBusy, false);
});

test('ActionManager — cancel("paused") immediately stops and cancels action', async () => {
  const mockBot = createMockBot();
  const telemetryEvents = [];
  const manager = new ActionManager({
    bot: mockBot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: (e) => telemetryEvents.push(e) },
  });

  const actionPromise = manager.run(
    'navigate',
    { x: 50, y: 64, z: 50 },
    5000,
    async (signal) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
  );

  // Cancel with 'paused'
  const cancelled = manager.cancel('paused');
  assert.equal(cancelled, true);

  const res = await actionPromise;
  assert.equal(res.outcome, 'cancelled');
  assert.equal(res.reason, 'paused');
  assert.equal(mockBot.pathfinder.stopCalls > 0, true);
  assert.equal(manager.isBusy, false);
});

test('ActionManager — produces exactly one action_end event even under multiple cancellations', async () => {
  const mockBot = createMockBot();
  const telemetryEvents = [];
  const manager = new ActionManager({
    bot: mockBot,
    getState: () => ({ active: true, ready: true, sessionId: 1 }),
    telemetry: { emit: (e) => telemetryEvents.push(e) },
  });

  const actionPromise = manager.run(
    'navigate',
    { x: 50, y: 64, z: 50 },
    5000,
    async (signal) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
  );

  // Trigger multiple cancellations in rapid succession (e.g. death then disconnect)
  manager.cancel('died');
  manager.cancel('disconnected');
  manager.cancel('user_quit');

  const res = await actionPromise;
  assert.equal(res.outcome, 'cancelled');
  assert.equal(res.reason, 'died');

  const actionEndEvents = telemetryEvents.filter((e) => e.event === 'action_end');
  assert.equal(actionEndEvents.length, 1, 'Must emit exactly one action_end event');
});
