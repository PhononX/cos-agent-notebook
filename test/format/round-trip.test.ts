import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseNote, serializeNote } from '../../src/format/note.ts'
import { STARTER_FILES } from '../../src/format/layout.ts'
import { fixtureNotes } from '../helpers/fixture.ts'

describe('round trip on the fixture notebook', () => {
  const notes = fixtureNotes()

  it('covers every file type in the format', () => {
    const types = new Set([...notes.keys()].map((p) => parseNote(p, '').type))
    for (const t of [
      'now',
      'brief',
      'catch-up',
      'nudges',
      'inbox',
      'actions',
      'waiting',
      'ideas',
      'links',
      'facts',
      'decisions',
      'about-me',
      'my-rules',
      'sources',
      'person',
      'project',
      'area',
      'draft',
      'log',
      'archive',
    ]) {
      assert.ok(types.has(t as never), `fixture has no ${t} note`)
    }
    for (const f of STARTER_FILES) assert.ok(notes.has(f), `fixture has no ${f}`)
  })

  for (const [path, text] of notes) {
    it(`gives back identical bytes for ${path}`, () => {
      assert.equal(serializeNote(parseNote(path, text)), text)
    })
  }
})
