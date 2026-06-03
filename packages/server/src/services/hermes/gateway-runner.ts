import { getActiveProfileDir } from './hermes-profile'
import { spawnHermesWithBin } from './hermes-process'

export function startGatewayRunManaged(
  hermesBin: string,
  opts: { profileDir?: string; port?: number } = {},
): { pid: number | null; reused: boolean } {
  const profileDir = opts.profileDir || getActiveProfileDir()
  if (opts.port !== undefined && (opts.port < 1 || opts.port > 65535 || !Number.isInteger(opts.port))) {
    throw new Error(`Invalid gateway port: ${opts.port}`)
  }
  const child = spawnHermesWithBin(hermesBin, ['gateway', 'run', '--replace'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      HERMES_HOME: profileDir,
      ...(opts.port ? { API_SERVER_PORT: String(opts.port) } : {}),
    },
  })
  child.unref()

  const pid = child.pid ?? null
  return { pid, reused: false }
}
