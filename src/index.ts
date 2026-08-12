import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConfigError, loadPolicy, readConfig } from './config.ts'
import { Guard } from './guard.ts'
import { createLogger } from './observability/log.ts'
import { PolicyError } from './policy/load.ts'

async function main(): Promise<void> {
  let config: ReturnType<typeof readConfig>
  try {
    config = readConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`waha-guard: ${error.message}`)
      process.exit(2)
    }
    throw error
  }

  const log = createLogger(config.logLevel)

  let policy: Awaited<ReturnType<typeof loadPolicy>>
  try {
    policy = await loadPolicy(config)
  } catch (error) {
    if (error instanceof PolicyError) {
      console.error(`waha-guard: ${error.message}`)
      process.exit(2)
    }
    throw error
  }

  mkdirSync(dirname(config.statePath), { recursive: true })
  const guard = new Guard({ config, policy, log })

  const server = Bun.serve({
    port: config.port,
    hostname: config.hostname,
    // Long typing plans and pacing waits hold the connection open in `block` mode.
    idleTimeout: 255,
    fetch: (req) => guard.fetch(req),
  })

  log.info('waha-guard listening', {
    url: `http://${server.hostname}:${server.port}`,
    upstream: config.upstream,
    webhookTarget: config.webhookTarget,
    webhookTargets: config.webhookTargets,
    webhookPath: config.webhookPath,
    preset: policy.preset,
    state: config.statePath,
  })
  if (!config.webhookTarget && Object.keys(config.webhookTargets).length === 0) {
    log.warn(
      'GUARD_WEBHOOK_TARGET is not set — the guard will observe webhooks but forward nothing',
    )
  } else if (!config.webhookTarget) {
    // Worth saying out loud: with a map and no fallback, a session nobody listed forwards
    // nowhere, and the first sign of it is an account that has simply gone quiet.
    log.info('per-session webhook targets only — sessions outside this map will not forward', {
      sessions: Object.keys(config.webhookTargets),
    })
  }
  if (!policy.contacts.requireHumanTouch) {
    log.warn(
      'contacts.requireHumanTouch is off — the guard will send to contacts no human has ever messaged',
    )
  }

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal })
    await server.stop(true)
    await guard.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

await main()
