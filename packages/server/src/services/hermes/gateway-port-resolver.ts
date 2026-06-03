import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { createServer } from 'net'
import { logger } from '../logger'

const PORT_FILE = 'gateway_port.json'
const DEFAULT_PORT = 8642
const PORT_SCAN_RANGE = 100

interface PortAssignment {
  port: number
}

// In-memory lock to prevent concurrent port assignment
let assignmentLock: Promise<void> = Promise.resolve()

function portFilePath(profileDir: string): string {
  return join(profileDir, PORT_FILE)
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.on('error', (err: any) => {
      resolve(err?.code === 'EADDRINUSE' ? false : true)
    })
    server.listen(port, () => {
      server.close(() => resolve(true))
    })
  })
}

async function readAssignedPort(profileDir: string): Promise<number | null> {
  try {
    const data = JSON.parse(await readFile(portFilePath(profileDir), 'utf-8')) as PortAssignment
    const port = typeof data.port === 'number' ? data.port : null
    return port && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

async function writeAssignedPort(profileDir: string, port: number): Promise<void> {
  const filePath = portFilePath(profileDir)
  await mkdir(profileDir, { recursive: true })
  await writeFile(filePath, JSON.stringify({ port }) + '\n', { mode: 0o600 })
}

export async function resolveAndAssignPort(
  profileDir: string,
  allProfileDirs: string[],
  profileName?: string,
): Promise<number> {
  // Serialize to prevent concurrent port collision
  return new Promise((resolve, reject) => {
    assignmentLock = assignmentLock.then(() =>
      doResolveAndAssignPort(profileDir, allProfileDirs, profileName).then(resolve, reject),
    )
  })
}

async function doResolveAndAssignPort(
  profileDir: string,
  allProfileDirs: string[],
  profileName?: string,
): Promise<number> {
  // Default profile always uses 8642
  if (profileName === 'default') {
    return DEFAULT_PORT
  }

  // Try to reuse previously assigned port
  const saved = await readAssignedPort(profileDir)
  if (saved && await isPortAvailable(saved)) {
    return saved
  }

  // Collect ports already assigned to other profiles
  const usedPorts = new Set<number>()
  usedPorts.add(DEFAULT_PORT)
  for (const dir of allProfileDirs) {
    if (dir === profileDir) continue
    const p = await readAssignedPort(dir)
    if (p) usedPorts.add(p)
  }

  // Find next available port starting from 8643
  for (let port = DEFAULT_PORT + 1; port < DEFAULT_PORT + PORT_SCAN_RANGE; port++) {
    if (usedPorts.has(port)) continue
    if (await isPortAvailable(port)) {
      await writeAssignedPort(profileDir, port)
      return port
    }
  }

  throw new Error(`No available port found in range ${DEFAULT_PORT + 1}-${DEFAULT_PORT + PORT_SCAN_RANGE}`)
}

export async function clearAssignedPort(profileDir: string): Promise<void> {
  try {
    await unlink(portFilePath(profileDir))
  } catch {
    // best effort
  }
}
