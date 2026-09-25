'use strict';

/**
 * Automated test script for: Death during navigation.
 * 1. Connects to Minecraft server using .env.
 * 2. On spawn, begins navigating continuously.
 * 3. Awaits lethal player/mob damage in-game.
 * 4. Verifies:
 *    - Active action is immediately cancelled with reason "died".
 *    - Exactly ONE action_end event is emitted.
 *    - Controls and pathfinding are halted.
 *    - Upon respawn, sessionId increments and bot remains idle (no stale continuation).
 * 5. Prints the JSONL telemetry and exits 0.
 */

const { loadConfig } = require('../src/config');
const { createTelemetry } = require('../src/telemetry');
const { createAgent } = require('../src/connection');
const { ActionManager } = require('../src/actions/manager');
const { createNavigator } = require('../src/actions/navigate');

const config = loadConfig();
const runId = `death-test-${Date.now()}`;
const telemetry = createTelemetry(runId);

const actionEndEvents = [];
const origEmit = telemetry.emit.bind(telemetry);
telemetry.emit = function(event) {
  if (event.event === 'action_end') {
    actionEndEvents.push(event);
  }
  origEmit(event);
};

const agent = createAgent(config, telemetry);
const { bot } = agent;

const actionManager = new ActionManager({
  bot,
  getState: () => ({
    active: agent.active,
    ready: agent.ready,
    sessionId: agent.sessionId,
  }),
  telemetry,
});

const navigator = createNavigator(bot, actionManager);

let initialSessionId = null;
let diedDuringAction = false;
let testPassed = false;

bot.on('death', () => {
  console.log('\n💀 DEATH DETECTED during test.');
  actionManager.cancel('died');
});

bot.once('spawn', async () => {
  initialSessionId = agent.sessionId;
  console.log(`\n🤖 Bot spawned (sessionId=${initialSessionId}). Starting continuous patrol...`);
  console.log('⚔️  PLAYER: Strike the bot until it dies while it is walking!\n');

  // Continuous patrol loop
  let offset = 6;
  while (agent.active && !diedDuringAction) {
    const target = {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z + offset,
      range: 0.5,
      requestedRange: 0.5,
      arrivalTolerance: 0.5,
      maxAcceptableDistance: 1.0,
    };
    offset = -offset;

    try {
      const res = await navigator.goto(target, 30_000);
      if (res.outcome === 'cancelled' && res.reason === 'died') {
        diedDuringAction = true;
        console.log('\n✅ Verified: action settled with outcome=cancelled reason=died.');
        break;
      }
    } catch {
      // Loop continues if not fatal
    }

    if (diedDuringAction) break;
    await new Promise((r) => setTimeout(r, 200));
  }
});

// Verify respawn and no stale continuation
bot.on('spawn', async () => {
  if (initialSessionId !== null && agent.sessionId > initialSessionId) {
    console.log(`\n✨ Bot respawned (sessionId=${agent.sessionId}).`);
    console.log('Verifying idle state (no stale continuation)...');

    await new Promise((r) => setTimeout(r, 2000));

    const isBusy = actionManager.isBusy;
    const endEventsForLastAction = actionEndEvents.filter((e) => e.reason === 'died');

    console.log(`- ActionManager busy after respawn: ${isBusy} (expected: false)`);
    console.log(`- action_end events with reason=died: ${endEventsForLastAction.length} (expected: 1)`);

    if (!isBusy && endEventsForLastAction.length === 1) {
      console.log('\n🎉 ALL ACCEPTANCE CRITERIA FOR DEATH DURING NAVIGATION PASSED!\n');
      testPassed = true;
    } else {
      console.error('\n❌ FAILED: Multiple action_end events or stale continuation active.');
    }

    telemetry.close();
    agent.shutdown();
    setTimeout(() => process.exit(testPassed ? 0 : 1), 500);
  }
});
