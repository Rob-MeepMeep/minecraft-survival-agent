'use strict';
const fs = require('fs');
const readline = require('readline');

const targetPath = process.argv[2] || 'artifacts/stage4-runs/stage4-1790541075638/telemetry.jsonl';
if (!fs.existsSync(targetPath)) {
  console.error('File not found:', targetPath);
  process.exit(1);
}

const rl = readline.createInterface({
  input: fs.createReadStream(targetPath),
  crlfDelay: Infinity,
});

let lastHp = null;
let lastEntry = null;
let lineNum = 0;
const damageEvents = [];

rl.on('line', (line) => {
  lineNum++;
  if (!line.trim()) return;
  try {
    const entry = JSON.parse(line);
    let hp = null;
    let food = null;
    let pos = null;
    let tod = null;

    if (entry.event === 'snapshot' && entry.state) {
      hp = entry.state.health;
      food = entry.state.food;
      pos = entry.state.position;
      tod = entry.state.timeOfDay;
    } else if (entry.health !== undefined) {
      hp = entry.health;
      food = entry.food;
      pos = entry.position;
      tod = entry.timeOfDay;
    }

    if (hp !== null && hp !== undefined) {
      if (lastHp !== null && hp < lastHp) {
        damageEvents.push({
          lineNum,
          timestamp: entry.timestamp,
          timeOfDay: tod,
          fromHp: lastHp,
          toHp: hp,
          delta: hp - lastHp,
          food,
          pos,
          nearbyThreats: entry.state?.nearbyThreats,
          event: entry.event,
        });
      }
      lastHp = hp;
    }
    lastEntry = entry;
  } catch (err) {}
});

rl.on('close', () => {
  console.log(`=== DAMAGE TIMELINE (${damageEvents.length} drops) ===`);
  for (const d of damageEvents) {
    console.log(
      `Line ${d.lineNum} [${d.timestamp}] TOD: ${d.timeOfDay} | HP: ${d.fromHp.toFixed(2)} -> ${d.toHp.toFixed(2)} (delta: ${d.delta.toFixed(2)}) | Food: ${d.food} | Pos: (${d.pos?.x?.toFixed(1)}, ${d.pos?.y?.toFixed(1)}, ${d.pos?.z?.toFixed(1)}) | Threats: ${JSON.stringify(d.nearbyThreats || [])}`
    );
  }
});
