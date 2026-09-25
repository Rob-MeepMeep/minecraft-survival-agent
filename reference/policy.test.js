// REFERENCE ONLY — Original prototype from handoff appendix.
// Not used in Stage 1. Preserved for later stages.

const {test} = require('node:test')
const assert = require('node:assert/strict')
const {choose} = require('./policy')
const ready = {food:20,night:false,sheltered:false,logs:4,planks:16,sticks:2,pickaxe:1,dirt:25,hasFood:false}
test('food takes priority over construction',()=>assert.equal(choose({...ready,food:10,hasFood:true,night:true}),'eat'))
test('takes shelter at night when supplied',()=>assert.equal(choose({...ready,night:true}),'shelter'))
test('stays enclosed at night and leaves in daylight',()=>{
 assert.equal(choose({...ready,night:true,sheltered:true}),'wait')
 assert.equal(choose({...ready,sheltered:true}),'leave')
})
test('fresh spawn gathers wood',()=>assert.equal(choose({...ready,logs:0,planks:0,pickaxe:0,dirt:0}),'wood'))
