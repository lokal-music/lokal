import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { focusRow, focusRowUntilVocalsFinish, lineEndOf } from '../src/lyrics/timing.js'

const require = createRequire(import.meta.url)
const { fromPrivateTag } = require('../electron/lyrics/embedded.js')

// Anonymized native LOKAL_LYRICS timestamps taken from the supplied Pump It
// FLAC. A standard LYRICS tag has only the flattened lead; the desktop native
// tag preserves separate [b]/[bw] timing for 41 supporting-vocal entries.
const native = {
  lokal:1, sync:'syllable', duet:true, lines:[
    {t:15.902,x:'Lead A',w:[['Lead',15.902,16.564,0]],
      b:'Harmony A',bw:[['Harmony',16.732,17.660,0]],a:'v3'},
    {t:17.669,x:'Lead B',w:[['Lead',17.669,18.330,0]],a:'v3'},
    {t:35.223,x:'Lead C',w:[['Lead',35.223,36.282,0]],
      b:'Harmony C',bw:[['Harmony',36.421,36.739,0]],a:'v1'},
    {t:36.711,x:'Lead D',w:[['Lead',36.711,38.090,0]],a:'v3'},
  ],
}
const { lines } = fromPrivateTag(JSON.stringify(native))

test('native backing events outlast main words and survive next lead onset', () => {
  assert.equal(lines.length,4)
  assert.equal(lines[0].words.at(-1).end,16.564)
  assert.equal(lines[0].bgWords.at(-1).end,17.66)
  assert.equal(lineEndOf(lines[0]),17.66)
  assert.equal(lineEndOf(lines[2]),36.739)
})

test('current line does not jump ahead of the last backing vocal', () => {
  assert.equal(focusRowUntilVocalsFinish(lines,16.8,0.25),0)
  assert.equal(focusRowUntilVocalsFinish(lines,17.659,0.25),0)
  assert.equal(focusRowUntilVocalsFinish(lines,17.669,0.25),1)
  // The new lead begins at 36.711, but the old backing ends at 36.739.
  assert.equal(focusRow(lines,36.72),3)
  assert.equal(focusRowUntilVocalsFinish(lines,36.72,0.25),2)
  assert.equal(focusRowUntilVocalsFinish(lines,36.738,0.25),2)
  assert.equal(focusRowUntilVocalsFinish(lines,36.739,0.25),3)
  assert.equal(focusRowUntilVocalsFinish(lines,36.740,0.25),3)
})

test('overlap-aware focus is deterministic after backward and forward seeks', () => {
  assert.equal(focusRowUntilVocalsFinish(lines,36.72),2)
  assert.equal(focusRowUntilVocalsFinish(lines,16.9),0)
  assert.equal(focusRowUntilVocalsFinish(lines,36.740),3)
})

test('line-only LRC retains conventional next timestamp focus', () => {
  const plain=[{time:10,text:'One',words:[]},{time:12,text:'Two',words:[]}]
  assert.equal(focusRowUntilVocalsFinish(plain,11.99),0)
  assert.equal(focusRowUntilVocalsFinish(plain,12),1)
})

test('the longest of lead or backing word lanes decides completion', () => {
  const longerLead=[
    {time:1,text:'Lead',words:[{time:1,end:4}],
      bgText:'Harmony',bgWords:[{time:1.5,end:2.5}]},
    {time:3,text:'Next',words:[{time:3,end:4.5}]},
  ]
  assert.equal(focusRowUntilVocalsFinish(longerLead,3.5),0)
  assert.equal(focusRowUntilVocalsFinish(longerLead,4),1)
})
