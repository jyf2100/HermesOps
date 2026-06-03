import Router from '@koa/router'
import * as ctrl from '../controllers/health'

export const healthRoutes = new Router()

healthRoutes.get('/health', ctrl.healthCheck)

// Connectivity check stub for Claude Code.
// Claude Code v1.x sends a startup GET to /api/hello; in restricted networks
// the original api.anthropic.com is unreachable, so we patch cli.js to point
// here instead.  Returning 200 is sufficient to pass the check.
healthRoutes.get('/api/hello', (ctx: any) => {
  ctx.body = { status: 'ok' }
})

export { startVersionCheck } from '../controllers/health'
