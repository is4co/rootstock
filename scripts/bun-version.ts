// Keep the Bun version deterministic wherever this repository acquires it.
//
// `.bun-version` is the single source of truth. CI reads that file directly,
// and `bun run check` verifies both the file and the Bun running the check.

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

export const PIN_FILE = '.bun-version'

export async function pinnedVersion(): Promise<string> {
  const version = (await Bun.file(`${root}/${PIN_FILE}`).text()).trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${PIN_FILE} must contain one exact version, got ${JSON.stringify(version)}`)
  }
  return version
}

export async function declaredProblems(): Promise<string[]> {
  const workflow = '.github/workflows/ci.yml'
  const text = await Bun.file(`${root}/${workflow}`).text()
  const problems: string[] = []

  if (!/^\s*bun-version-file:\s*\.bun-version\s*$/m.test(text)) {
    problems.push(`${workflow} must configure setup-bun with bun-version-file: .bun-version`)
  }

  return problems
}

if (import.meta.main) {
  const pinned = await pinnedVersion()
  const problems = await declaredProblems()

  if (Bun.version !== pinned) {
    problems.push(`this Bun is ${Bun.version}; ${PIN_FILE} pins ${pinned}`)
  }

  if (problems.length > 0) {
    console.error(`\n✗ Bun toolchain pin (${PIN_FILE} = ${pinned})\n`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  console.log(`✓ Bun ${Bun.version} matches ${PIN_FILE}`)
}
