/** Protocol fixture: the Desktop Host control wiring over real stdio, with a fake profile boot. */

import { installShellControl, stdioShellTransport } from '../../src/shell-control.ts'

/** The fake profile boot result; the shutdown stub reports its call on stderr. */
interface FixtureApplication {
  shutdown: { shutdown(exitCode: number): Promise<void> }
}

const failUpdateTasks = process.env.DSH_FIXTURE_UPDATE_TASKS === 'fail'
const application = Promise.withResolvers<FixtureApplication>()
const control = installShellControl(stdioShellTransport(), application.promise, {
  reportInvalidFrame: (message) => { console.error('desktop-host fixture: ignoring an invalid control frame', message) },
})
control.installUpdateTasks(async () => {
  if (failUpdateTasks) throw new Error('fixture task failure')
  return false
})
application.resolve({
  shutdown: { shutdown: async (exitCode) => { console.error(`desktop-host fixture: shutdown(${String(exitCode)})`) } },
})
await control.reportReady('http://127.0.0.1:19387/')
