// The driver registry (architecture §1.2, "a library plus a driver registry").
// Trellis selects an engine by id string, never by import path — that seam is
// what makes engines swappable. Exactly two exports live here; anything more
// is unpinned API surface.

import type { Driver } from './types'

const drivers = new Map<string, Driver>()

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
 */
export function getDriver(id: string): Driver {
  const driver = drivers.get(id)
  if (!driver) {
    const known = [...drivers.keys()].join(', ') || 'none'
    throw new Error(`no driver registered as '${id}' (registered: ${known})`)
  }
  return driver
}
