import { appendFileSync } from 'node:fs'

let input = ''
for await (const chunk of process.stdin) input += chunk
const payload = JSON.parse(input)
const { fixture, captureFile } = payload.cfg
appendFileSync(captureFile, JSON.stringify({ action: payload.action, instanceId: payload.instanceId }) + '\n')
if (payload.action !== 'reuse' || payload.streamStdout !== true) {
  throw new Error('expected exactly one streaming reuse action')
}
if (fixture.statusLine !== null) {
  process.stdout.write('@' + JSON.stringify({ status: fixture.statusLine ?? fixture.status }) + '\n')
}
if (fixture.sse) process.stdout.write(fixture.sse)
process.stdout.write('>' + JSON.stringify({
  chat: { status: fixture.status, text: fixture.text },
  startRun: { runId: 'fixture-run' },
  model: { name: 'fixture-model' },
}) + '\n')
