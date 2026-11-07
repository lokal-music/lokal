const { fixture } = require('./phone-upload-fixture.cjs')
const [root,stage] = process.argv.slice(2)
fixture({root,boundary: edge => {
  if(edge===stage)process.exit(73)
  if(stage==='hold:'+edge){ process.send({edge});return new Promise(resolve=>{process.once('message',resolve)}) }
}}).then(f => {
  process.send({url:f.url})
}).catch(error=>{ process.stderr.write(String(error));process.exit(1) })
