import { startStack, stopStack } from '../support/stack'
startStack().then((s) => { console.log(JSON.stringify({ up: true, fixtures: s.fixtures })); console.log('Stack running; Ctrl-C to stop.'); process.on('SIGINT', () => { stopStack(s); process.exit(0) }) }).catch((e) => { console.error(e.message); stopStack(); process.exit(1) })
