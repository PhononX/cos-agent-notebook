import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseNote } from '../../src/format/note.ts'
import { itemId, ITEM_ID } from '../../src/format/ids.ts'
import { parseItemLine, renderItem, setField } from '../../src/format/item.ts'
import {
  frontMatterValue,
  renderFrontMatterEntry,
  parseFrontMatter,
} from '../../src/format/front-matter.ts'
import { fixtureNotes } from '../helpers/fixture.ts'

const notes = fixtureNotes()
const note = (p: string) => parseNote(p, notes.get(p)!)

describe('item lines', () => {
  it('reads the checkbox, sentence, fields and links', () => {
    const it0 = parseItemLine(
      '- [ ] Send the v3 pricing deck to [[Dana Whitfield]] for [[Q4 Launch]] [due:: 2026-10-16] [src:: cv 2026-10-13]',
    )!
    assert.equal(it0.checked, false)
    assert.equal(it0.text, 'Send the v3 pricing deck to [[Dana Whitfield]] for [[Q4 Launch]]')
    assert.deepEqual(it0.fields, [
      { key: 'due', value: '2026-10-16' },
      { key: 'src', value: 'cv 2026-10-13' },
    ])
    assert.deepEqual(it0.links, ['Dana Whitfield', 'Q4 Launch'])
    assert.deepEqual(it0.problems, [])
  })

  it('reads numbered items, * markers, [X] and Markdown links', () => {
    assert.equal(parseItemLine('1. Send it [src:: cv 2026-10-13]')!.marker, '1.')
    assert.equal(parseItemLine('* [X] Done')!.checked, true)
    const link = parseItemLine(
      '- [Form](https://forms.example.com/a) for [[Q4 Launch]] [src:: slack 2026-10-03]',
    )!
    assert.equal(link.text, '[Form](https://forms.example.com/a) for [[Q4 Launch]]')
  })

  it('reads links inside field values, with aliases and headings', () => {
    const l = parseItemLine(
      '- See [[Dana Whitfield|Dana]] and [[Q4 Launch#Next]] [for:: [[Jordan Kim]]]',
    )!
    assert.deepEqual(l.links, ['Dana Whitfield', 'Q4 Launch', 'Jordan Kim'])
    assert.deepEqual(l.fields, [{ key: 'for', value: '[[Jordan Kim]]' }])
  })

  it('is not an item: headings, rules, empty markers, paragraphs', () => {
    for (const l of ['# Title', '---', '- ', '-', 'Plain text', '  > quote']) {
      assert.equal(parseItemLine(l), null, l)
    }
  })

  it('reports lines that do not fit, without failing', () => {
    assert.match(
      parseItemLine('- [src:: cv 2026-10-14] Fields first')!.problems[0]!,
      /after the sentence/,
    )
    assert.match(parseItemLine('- Half [src:: cv 2026-10-14')!.problems.join(), /isn't closed/)
    assert.match(parseItemLine('- Typo [due: tomorrow]')!.problems.join(), /one colon/)
    assert.match(parseItemLine('- Broken [[link')!.problems.join(), /link/)
  })

  it('renders fields in order, with src last', () => {
    let fields = setField([{ key: 'src', value: 'cv 2026-10-13' }], 'due', '2026-10-16')
    fields = setField(fields, 'done', '2026-10-17')
    assert.equal(
      renderItem({ checked: true, text: 'Send it', fields }),
      '- [x] Send it [due:: 2026-10-16] [done:: 2026-10-17] [src:: cv 2026-10-13]',
    )
  })
})

describe('notes', () => {
  it('gives every item an id and its section', () => {
    const actions = note('actions.md')
    const first = actions.items[0]!
    assert.match(first.id, ITEM_ID)
    assert.equal(first.id, itemId('actions.md', first.raw, 0))
    assert.deepEqual(first.section, ['My actions', 'To do'])
    assert.deepEqual(actions.items.at(-1)!.section, ['My actions', 'Elsewhere'])
  })

  it('attaches indented quote lines to the item above', () => {
    const offer = note('actions.md').items.find((i) => i.text.startsWith('Draft the uptime'))!
    assert.deepEqual(offer.quote, [
      'Something fair, maybe one month of credit. Have it ready by Friday.',
    ])
    const followUp = note('brief.md').items.find((i) => i.marker === '1.')!
    assert.equal(followUp.quoteCount, 1)
  })

  it('does not attach an unindented quote (deck speaker notes)', () => {
    const deck = note('drafts/Q4 launch deck.md')
    assert.equal(deck.items.find((i) => i.text.startsWith('Small teams'))!.quoteCount, 0)
  })

  it('gives identical lines different ids by occurrence', () => {
    const repeats = note('nudges.md').items.filter(
      (i) => i.text === 'Check the calendar for Friday',
    )
    assert.equal(repeats.length, 2)
    assert.notEqual(repeats[0]!.id, repeats[1]!.id)
  })

  it('ignores lines in code fences and reads tab-indented items', () => {
    const q4 = note('projects/Q4 Launch.md')
    assert.ok(!q4.items.some((i) => i.text.includes('inside a code fence')))
    assert.ok(q4.items.some((i) => i.indent === '\t'))
  })

  it('reads headings with fields (brief sent times)', () => {
    const brief = note('brief.md')
    const morning = brief.headings.find((h) => h.title === 'Morning brief')!
    assert.deepEqual(morning.fields, [{ key: 'sent', value: '07:02' }])
  })

  it('reads CRLF files', () => {
    const sources = note('sources.md')
    assert.equal(sources.items.length, 3)
    assert.equal(sources.items[0]!.text, 'Carbon Voice')
  })

  it('reports problems with line numbers, and nothing for clean notes', () => {
    const inbox = note('inbox.md')
    assert.deepEqual(
      inbox.problems.map((p) => p.line),
      [8, 8, 9],
    )
    const actions = note('actions.md')
    assert.equal(actions.problems.length, 1)
    assert.match(actions.problems[0]!.message, /due should be a date/)
    for (const p of [
      'now.md',
      'brief.md',
      'catch-up.md',
      'decisions.md',
      'my-rules.md',
      'drafts/Board narrative.md',
    ]) {
      assert.deepEqual(note(p).problems, [], p)
    }
  })

  it('stays tolerant of anything', () => {
    for (const junk of [
      '---\nnot: closed',
      '- [x]',
      '```\n- a',
      '\u0000\u0001',
      '- [[[[]]]] [a:: [b]]',
    ]) {
      assert.doesNotThrow(() => parseNote('inbox.md', junk))
    }
  })
})

describe('front matter', () => {
  it('reads plain and quoted values', () => {
    const fm = note('drafts/Board narrative.md').frontMatter
    assert.equal(frontMatterValue(fm, 'for'), '[[Jordan Kim]]')
    assert.equal(frontMatterValue(fm, 'version'), '2')
    assert.equal(frontMatterValue(note('my-rules.md').frontMatter, 'timezone'), 'America/New_York')
  })

  it('reports lines that are not key: value', () => {
    const { problems } = parseFrontMatter(['---', 'tags:', '  - a', '---'])
    assert.equal(problems.length, 1)
  })

  it('quotes values that plain YAML would misread', () => {
    assert.equal(renderFrontMatterEntry('role', 'Head of Sales'), 'role: Head of Sales')
    assert.equal(renderFrontMatterEntry('for', '[[Jordan Kim]]'), 'for: "[[Jordan Kim]]"')
    assert.equal(renderFrontMatterEntry('note', 'a: b'), 'note: "a: b"')
    assert.equal(renderFrontMatterEntry('q', 'say "hi"'), 'q: say "hi"')
    assert.equal(renderFrontMatterEntry('q', '"hi"'), 'q: "\\"hi\\""')
    const back = parseFrontMatter(['---', renderFrontMatterEntry('q', '"hi" \\ x'), '---'])
    assert.equal(back.frontMatter!.entries[0]!.value, '"hi" \\ x')
  })
})
