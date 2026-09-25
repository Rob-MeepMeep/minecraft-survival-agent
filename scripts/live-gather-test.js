'use strict';

/**
 * Focused in-game verification test suite for Phase 2B:
 * 1. Under-feet safety rejection test (refuse to mine floor).
 * 2. Specifically identified bamboo block gathering & drop verification.
 * 3. Specifically identified grass_block gathering with dirt drop verification (preventing bamboo false attribution).
 * 4. Tool selection demonstration on tool-required block (stone -> pickaxe -> cobblestone).
 * 5. Uncollectible drop / full inventory case.
 * 6. Cancellation / interrupt during gather.
 */

const { loadConfig } = require('../src/config');
const { createTelemetry } = require('../src/telemetry');
const { createAgent } = require('../src/connection');
const { ActionManager } = require('../src/actions/manager');
const { createGatherer, getInventoryCounts } = require('../src/actions/gather');
const { Vec3 } = require('vec3');

const config = loadConfig();
const runId = `gather-test-${Date.now()}`;
const telemetry = createTelemetry(runId);

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

const gatherer = createGatherer(bot, actionManager);

bot.once('spawn', async () => {
  console.log('\n🤖 Agent spawned. Waiting 2s for world chunks and player positioning...');
  await new Promise((r) => setTimeout(r, 2000));
  console.log('Beginning Phase 2B focused verification suite...\n');

  try {
    // -----------------------------------------------------------------------
    // Pre-test setup: Clear inventory to ensure clean baseline
    // -----------------------------------------------------------------------
    bot.chat('/clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 600));

    // -----------------------------------------------------------------------
    // Test 1: Under-feet safety rejection test
    // -----------------------------------------------------------------------
    console.log('--- Test 1: Under-feet safety rejection test ---');
    const feetPos = {
      x: Math.floor(bot.entity.position.x),
      y: Math.floor(bot.entity.position.y) - 1,
      z: Math.floor(bot.entity.position.z),
    };

    console.log(`Attempting to mine supporting block under feet at (${feetPos.x}, ${feetPos.y}, ${feetPos.z})...`);
    const underFeetRes = await gatherer.gather(feetPos);

    if (underFeetRes.outcome === 'failed' && underFeetRes.reason === 'unsafe_target_under_feet') {
      console.log('✅ PASS: Correctly refused to mine supporting block beneath feet.');
    } else {
      console.error('❌ FAIL: Failed to reject mining under feet:', underFeetRes);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 2: Specifically identified bamboo block gathering
    // -----------------------------------------------------------------------
    console.log('\n--- Test 2: Specifically identified bamboo gathering ---');
    const bPos = {
      x: Math.floor(bot.entity.position.x) + 2,
      y: Math.floor(bot.entity.position.y),
      z: Math.floor(bot.entity.position.z),
    };

    // Ensure solid floor and bamboo block
    bot.chat(`/setblock ${bPos.x} ${bPos.y - 1} ${bPos.z} dirt`);
    bot.chat(`/setblock ${bPos.x} ${bPos.y} ${bPos.z} bamboo`);
    await new Promise((r) => setTimeout(r, 800));

    console.log(`Targeting bamboo block at (${bPos.x}, ${bPos.y}, ${bPos.z})...`);
    const bambooRes = await gatherer.gather(bPos, { timeoutMs: 30_000 });
    console.log('Bamboo gather result:', JSON.stringify(bambooRes, null, 2));

    const bambooMatched = bambooRes.matchedAcquisitions?.find((i) => i.name === 'bamboo');
    if (bambooRes.outcome === 'success' && bambooMatched && bambooRes.finalBlockState === 'air') {
      console.log(`✅ PASS: Successfully gathered bamboo, verified expected drop [bamboo], and confirmed final block is air.`);
    } else {
      console.error('❌ FAIL: Bamboo gathering did not meet expected attribution:', bambooRes);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 3: Specifically identified grass_block gathering (verifying dirt drop, NOT bamboo)
    // -----------------------------------------------------------------------
    console.log('\n--- Test 3: Specifically identified grass_block gathering (expected: dirt) ---');
    const gPos = {
      x: Math.floor(bot.entity.position.x) - 2,
      y: Math.floor(bot.entity.position.y),
      z: Math.floor(bot.entity.position.z),
    };

    // Ensure solid floor and grass_block
    bot.chat(`/setblock ${gPos.x} ${gPos.y - 1} ${gPos.z} dirt`);
    bot.chat(`/setblock ${gPos.x} ${gPos.y} ${gPos.z} grass_block`);
    await new Promise((r) => setTimeout(r, 800));

    console.log(`Targeting grass_block at (${gPos.x}, ${gPos.y}, ${gPos.z})...`);
    const grassRes = await gatherer.gather(gPos, { timeoutMs: 30_000 });
    console.log('Grass_block gather result:', JSON.stringify(grassRes, null, 2));

    const dirtMatched = grassRes.matchedAcquisitions?.find((i) => i.name === 'dirt');
    const bambooInGrass = grassRes.matchedAcquisitions?.find((i) => i.name === 'bamboo');

    if (grassRes.outcome === 'success' && dirtMatched && !bambooInGrass && grassRes.finalBlockState === 'air') {
      console.log(`✅ PASS: Successfully gathered grass_block with expected drop [dirt], confirmed final block is air, and prevented bamboo false attribution.`);
    } else {
      console.error('❌ FAIL: Grass block gathering failed expected attribution (dirt required, bamboo rejected):', grassRes);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 4: Tool selection demonstration on tool-required block (stone -> pickaxe)
    // -----------------------------------------------------------------------
    console.log('\n--- Test 4: Tool selection demonstration on stone (requires pickaxe) ---');
    bot.chat('/give SurvivalAgent wooden_pickaxe 1');
    await new Promise((r) => setTimeout(r, 600));

    const sPos = {
      x: Math.floor(bot.entity.position.x),
      y: Math.floor(bot.entity.position.y),
      z: Math.floor(bot.entity.position.z) + 2,
    };

    bot.chat(`/setblock ${sPos.x} ${sPos.y - 1} ${sPos.z} dirt`);
    bot.chat(`/setblock ${sPos.x} ${sPos.y} ${sPos.z} stone`);
    await new Promise((r) => setTimeout(r, 800));

    console.log(`Targeting stone at (${sPos.x}, ${sPos.y}, ${sPos.z}) with wooden_pickaxe in inventory...`);
    const stoneRes = await gatherer.gather(sPos, { timeoutMs: 30_000 });
    console.log('Stone gather result:', JSON.stringify(stoneRes, null, 2));

    const cobbleMatched = stoneRes.matchedAcquisitions?.find((i) => i.name === 'cobblestone');
    if (stoneRes.outcome === 'success' && cobbleMatched && stoneRes.finalBlockState === 'air') {
      console.log(`✅ PASS: Successfully equipped pickaxe, mined stone, gathered cobblestone, and confirmed final block is air.`);
    } else {
      console.error('❌ FAIL: Tool selection test failed on stone:', stoneRes);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Test 5: Uncollectible drop / full inventory case
    // -----------------------------------------------------------------------
    console.log('\n--- Test 5: Uncollectible drop / full inventory case ---');
    // Clear inventory first so no dirt remains to stack into
    bot.chat('/clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 600));

    // Fill inventory completely with 36 stacks of bedrock
    for (let slot = 0; slot < 36; slot++) {
      bot.chat('/give SurvivalAgent bedrock 64');
    }
    await new Promise((r) => setTimeout(r, 1500));

    const emptySlots = bot.inventory.emptySlotCount();
    console.log(`Inventory empty slots: ${emptySlots}, items: ${bot.inventory.items().length}`);

    const fPos = {
      x: Math.floor(bot.entity.position.x),
      y: Math.floor(bot.entity.position.y),
      z: Math.floor(bot.entity.position.z) - 2,
    };

    bot.chat(`/setblock ${fPos.x} ${fPos.y - 1} ${fPos.z} dirt`);
    bot.chat(`/setblock ${fPos.x} ${fPos.y} ${fPos.z} dirt`);
    await new Promise((r) => setTimeout(r, 800));

    console.log(`Targeting dirt at (${fPos.x}, ${fPos.y}, ${fPos.z}) with full inventory...`);
    const fullRes = await gatherer.gather(fPos, { timeoutMs: 30_000 });
    console.log('Full inventory gather result:', JSON.stringify(fullRes, null, 2));

    if (fullRes.outcome === 'failed' && (fullRes.reason === 'inventory_full' || fullRes.reason === 'drop_not_collected')) {
      console.log(`✅ PASS: Correctly reported failure (${fullRes.reason}) when drop could not be collected into full inventory.`);
    } else {
      console.error('❌ FAIL: Did not properly reject full inventory case:', fullRes);
      process.exit(1);
    }

    // Clean inventory after full test
    bot.chat('/clear SurvivalAgent');
    await new Promise((r) => setTimeout(r, 600));

    // -----------------------------------------------------------------------
    // Test 6: Interrupt / cancellation during gather
    // -----------------------------------------------------------------------
    console.log('\n--- Test 6: Cancellation during gather ---');
    const cPos = {
      x: Math.floor(bot.entity.position.x) + 3,
      y: Math.floor(bot.entity.position.y),
      z: Math.floor(bot.entity.position.z),
    };

    bot.chat(`/setblock ${cPos.x} ${cPos.y - 1} ${cPos.z} dirt`);
    bot.chat(`/setblock ${cPos.x} ${cPos.y} ${cPos.z} stone`);
    await new Promise((r) => setTimeout(r, 800));

    console.log(`Starting gather at (${cPos.x}, ${cPos.y}, ${cPos.z}) and cancelling after 200ms...`);
    const gatherPromise = gatherer.gather(cPos, { timeoutMs: 30_000 });

    setTimeout(() => {
      console.log('Issuing actionManager.cancel("user_cancel")...');
      actionManager.cancel('user_cancel');
    }, 200);

    const cancelRes = await gatherPromise;
    if (cancelRes.outcome === 'cancelled' && cancelRes.reason === 'user_cancel') {
      console.log('✅ PASS: Gathering cancelled cleanly upon interrupt.');
    } else {
      console.error('❌ FAIL: Cancel attempt result:', cancelRes);
      process.exit(1);
    }

    console.log('\n🎉 ALL 6 PHASE 2B FOCUSED TESTS PASSED CLEANLY!\n');
  } catch (err) {
    console.error('❌ Error during live gather test suite:', err);
    process.exit(1);
  } finally {
    telemetry.close();
    agent.shutdown();
    setTimeout(() => process.exit(0), 500);
  }
});
