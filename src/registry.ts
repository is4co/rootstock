// The driver registry (architecture §1.2, "a library plus a driver registry").
// Trellis selects an engine by id string, never by import path — that seam is
// what makes engines swappable. Exactly two exports live here; anything more
// is unpinned API surface.

import { withBudget } from './budget'
import type { Driver, Session, SessionId, SessionOptions } from './types'

const drivers = new Map<string, Driver>()

/** One guard per registered driver, so `getDriver(id)` is stable across calls. */
const guards = new WeakMap<Driver, Driver>()

/**
 * Register a driver under its own id. Registering the same id twice throws —
 * a silent overwrite would let two engines fight over one name.
 */
export function registerDriver(driver: Driver): void {
  if (drivers.has(driver.id)) throw new Error(`driver already registered: ${driver.id}`)
  drivers.set(driver.id, driver)
}

/**
 * Look up a driver by id. An unknown id throws, naming what IS registered, so
 * a misconfigured trellis deployment fails with a legible message instead of
 * an undefined further down.
 *
 * What comes back is the registered driver behind a budget guard: sessions it
 * opens with a `budget` in their options are wrapped by `withBudget`, and
 * sessions opened without one are handed through exactly as the driver made
 * them. This is the seam every consumer already crosses, which is what makes
 * the caps universal — a third-party driver inherits them by existing, and no
 * driver is aware of budgets at all.
 */
export function getDriver(id: string): Driver {
  const driver = drivers.get(id)
  if (!driver) {
    const known = [...drivers.keys()].join(', ') || 'none'
    throw new Error(`no driver registered as '${id}' (registered: ${known})`)
  }
  return guarded(driver)
}

function guarded(driver: Driver): Driver {
  const existing = guards.get(driver)
  if (existing !== undefined) return existing
  const capped = (opts: SessionOptions, session: Session): Session =>
    opts.budget === undefined ? session : withBudget(session, opts.budget, driver.capabilities)
  const guard: Driver = {
    id: driver.id,
    // A getter, not a copy: what the driver declares is what the guard reports,
    // including anything it decides at construction time.
    get capabilities() {
      return driver.capabilities
    },
    models: () => driver.models(),
    start: async (opts: SessionOptions): Promise<Session> => capped(opts, await driver.start(opts)),
    resume: async (sessionId: SessionId, opts: SessionOptions): Promise<Session> =>
      capped(opts, await driver.resume(sessionId, opts)),
  }
  guards.set(driver, guard)
  return guard
}
