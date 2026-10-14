import type { Register } from 'claude-code'

const PANE = 'win95'
let last = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'win95', description: 'Open the Windows 95 desktop pane' })
    void $.ui.open({ id: PANE, title: 'Windows 95' })
    return next(e)
  })
  on('command.run', { command: 'win95' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Windows 95' })
    return { text: 'Windows 95 pane opened.' }
  })
  on('ui.message', async ($, e) => {
    last = JSON.stringify(e.data)
    $.ui.log('win95 probe ' + e.surface + ': ' + last, { to: 'debug' })
    $.ui.log('win95 probe: ' + last)
    return {}
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Client } = $.ui.resolve(e) as any
    return (
      <Box flexDirection="column">
        <Text>surface {e.surface}</Text>
        {Client ? <Client key="probe" module="./probe.tsx" /> : <Text>no Client</Text>}
      </Box>
    )
  })
}
