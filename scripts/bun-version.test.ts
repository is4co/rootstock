import { expect, test } from 'bun:test'

import { declaredProblems, pinnedVersion, PIN_FILE } from './bun-version'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

test(`${PIN_FILE} contains one exact version`, async () => {
  expect(await pinnedVersion()).toMatch(/^\d+\.\d+\.\d+$/)
})

test('CI reads the Bun version from the pin file', async () => {
  expect(await declaredProblems()).toEqual([])
})

test('no workflow acquires Bun without the pin', async () => {
  const directory = `${root}/.github/workflows`
  const workflows = [...new Bun.Glob('*.yml').scanSync(directory)].sort()
  const unpinned: string[] = []

  for (const workflow of workflows) {
    const text = await Bun.file(`${directory}/${workflow}`).text()
    if (
      text.includes('oven-sh/setup-bun') &&
      !/^\s*bun-version-file:\s*\.bun-version\s*$/m.test(text)
    ) {
      unpinned.push(`.github/workflows/${workflow}`)
    }
  }

  expect(unpinned).toEqual([])
})
