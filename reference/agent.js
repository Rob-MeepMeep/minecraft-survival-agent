// REFERENCE ONLY — Original prototype from handoff appendix.
// Not used in Stage 1. Preserved for later stages.

const mineflayer = require('mineflayer')
const {pathfinder, Movements, goals} = require('mineflayer-pathfinder')
const {Vec3} = require('vec3')
const readline = require('node:readline')
const {choose, edible} = require('./policy')
const auth = process.env.MC_AUTH || 'microsoft'
if (!['microsoft', 'offline'].includes(auth)) throw new Error('MC_AUTH must be microsoft or offline')
const port = Number(process.env.MC_PORT || 25565)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MC_PORT')
const bot = mineflayer.createBot({host: process.env.MC_HOST || 'localhost', port,
  username: process.env.MC_USERNAME || 'SurvivalAgent', auth,
  version: process.env.MC_VERSION || false, profilesFolder: '.auth'})
bot.loadPlugin(pathfinder)
let active = false, paused = false, running = false, shelter = null, lastAction = ''
const failures = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const items = () => bot.inventory.items()
const count = test => items().filter(i => typeof test === 'string' ? i.name === test : test(i.name)).reduce((s,i) => s+i.count,0)
const log = message => console.log(new Date().toISOString(), message)
function check() { if (!active || paused) throw new Error('Paused or disconnected') }
async function go(pos, range = 2) {
  check()
  const timer = setTimeout(() => bot.pathfinder.setGoal(null), 15000)
  try { await bot.pathfinder.goto(new goals.GoalNear(pos.x,pos.y,pos.z,range)); check() }
  finally { clearTimeout(timer) }
}
async function gather(predicate) {
  check()
  const block = bot.findBlock({matching:b => predicate(b.name) && (failures.get(b.position.toString()) || 0) < Date.now(), maxDistance:32})
  if (!block) throw new Error('No reachable resource nearby')
  try {
    await go(block.position)
    check()
    if (!bot.canDigBlock(block)) throw new Error('Cannot safely reach block')
    await bot.dig(block)
    await go(block.position, 1)
    await sleep(500)
  } catch (e) { failures.set(block.position.toString(),Date.now()+60000); throw e }
}
async function craft(name, times = 1, table = null) {
  check()
  const id = bot.registry.itemsByName[name]?.id
  if (id === undefined) throw new Error('Unknown recipe: '+name)
  const recipe = bot.recipesFor(id,null,1,table)[0]
  if (!recipe) throw new Error('Missing ingredients for '+name)
  await bot.craft(recipe,times,table)
}
async function placeAt(pos, name) {
  check()
  if (bot.blockAt(pos)?.name !== 'air') throw new Error('Build location is obstructed')
  const item = items().find(i => i.name === name)
  if (!item) throw new Error('Missing '+name)
  for (const face of [new Vec3(0,1,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1),new Vec3(0,-1,0)]) {
    const ref = bot.blockAt(pos.minus(face))
    if (ref?.boundingBox === 'block') {
      await bot.equip(item,'hand'); check(); await bot.placeBlock(ref,face); return
    }
  }
  throw new Error('No supporting block')
}
async function pickaxe() {
  let table = bot.findBlock({matching:bot.registry.blocksByName.crafting_table.id,maxDistance:16})
  if (!table) {
    if (!count('crafting_table')) await craft('crafting_table')
    const base = bot.entity.position.floored()
    for (const delta of [new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
      const pos = base.plus(delta)
      if (bot.blockAt(pos)?.name === 'air' && bot.blockAt(pos.offset(0,-1,0))?.boundingBox === 'block') {
        await placeAt(pos,'crafting_table'); table = bot.blockAt(pos); break
      }
    }
  }
  if (!table) throw new Error('No space for crafting table')
  await go(table.position); await craft('wooden_pickaxe',1,table)
}
async function buildShelter() {
  const base = bot.entity.position.floored()
  const targets = []
  for (let y=0;y<2;y++) for(let x=-1;x<=1;x++) for(let z=-1;z<=1;z++) if(x || z) targets.push(base.offset(x,y,z))
  for(let x=-1;x<=1;x++) for(let z=-1;z<=1;z++) targets.push(base.offset(x,2,z))
  if (targets.some(p => bot.blockAt(p)?.name !== 'air') ||
      targets.slice(0,8).some(p => bot.blockAt(p.offset(0,-1,0))?.boundingBox !== 'block')) throw new Error('Shelter needs clear, flat 3x3 ground')
  await go(base,0)
  shelter = {base, placed:[], complete:false}
  for(const pos of targets) { await placeAt(pos,'dirt'); shelter.placed.push(pos) }
  shelter.complete = true
}
async function leaveShelter() {
  for (const pos of [...shelter.placed].reverse()) {
    check()
    const block = bot.blockAt(pos)
    if (block?.name === 'dirt' && bot.canDigBlock(block)) await bot.dig(block)
  }
  shelter = null
}
async function step() {
  const night = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23500
  const action = choose({food:bot.food,night,sheltered:!!shelter,hasFood:items().some(i=>edible.has(i.name)),
    logs:count(n=>n.endsWith('_log')),planks:count(n=>n.endsWith('_planks')),sticks:count('stick'),pickaxe:count(n=>n.endsWith('_pickaxe')),dirt:count('dirt')})
  if (action !== lastAction) { log('Action: '+action); lastAction = action }
  if (shelter && !shelter.complete) return leaveShelter()
  switch(action) {
    case 'eat': await bot.equip(items().find(i=>edible.has(i.name)),'hand'); check(); await bot.consume(); break
    case 'wood': await gather(n=>n.endsWith('_log')); break
    case 'planks': {
      const logItem = items().find(i=>i.name.endsWith('_log'))
      if (!logItem) throw new Error('Need more logs')
      await craft(logItem.name.replace(/_log$/,'_planks')); break
    }
    case 'sticks': await craft('stick'); break
    case 'pickaxe': await pickaxe(); break
    case 'dirt': await gather(n=>n==='dirt'); break
    case 'shelter': await buildShelter(); break
    case 'leave': await leaveShelter(); break
    case 'forage': {
      const drop = bot.nearestEntity(e=>e.name==='item' && e.position.distanceTo(bot.entity.position)<24)
      if (drop) await go(drop.position,0)
      else await gather(n=>n.endsWith('_leaves'))
      break
    }
    case 'wait': await sleep(1000); break
  }
}
async function loop() {
  if (running) return
  running = true
  try { while(active) {
    if (!paused) try { await step() } catch(e) { log(e.message); await sleep(2000) }
    await sleep(500)
  }} finally { running = false }
}
bot.on('spawn',()=>{
  const movement = new Movements(bot)
  movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.maxDropDown = 1
  bot.pathfinder.setMovements(movement)
  active = true; shelter = null
  log('Spawned. Terminal commands: pause, resume, status, quit.'); void loop()
})
bot.on('death',()=>{active=false; bot.pathfinder.setGoal(null); log('Died; waiting for respawn')})
bot.on('end',()=>{active=false; log('Disconnected. Restart to reconnect.'); process.exitCode=1; input.close()})
bot.on('kicked',reason=>log('Kicked: '+JSON.stringify(reason)))
bot.on('error',error=>log('Connection error: '+error.message))
const input = readline.createInterface({input:process.stdin,output:process.stdout})
input.on('line',line=>{
  const cmd = line.trim().toLowerCase()
  if(cmd==='pause') { paused=true; bot.pathfinder.setGoal(null); bot.stopDigging(); bot.clearControlStates(); log('Paused') }
  if(cmd==='resume') { paused=false; log('Resumed') }
  if(cmd==='status') log(JSON.stringify({active,paused,health:bot.health,food:bot.food,action:lastAction,inventory:bot.inventory ? items().map(i=>`${i.name}: ${i.count}`):[]},null,2))
  if(cmd==='quit') shutdown()
})
function shutdown() { active=false; paused=true; bot.pathfinder.setGoal(null); bot.quit(); input.close() }
process.on('SIGINT',shutdown)
