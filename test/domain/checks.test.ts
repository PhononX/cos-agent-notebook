import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkName, type KnownName } from '../../src/domain/names.ts'
import { findSecret } from '../../src/domain/secrets.ts'
import { normalize, phraseMatches, textSimilarity } from '../../src/domain/similarity.ts'
import { zonedNow } from '../../src/domain/time.ts'
import { isDate, nameProblem, parseSrc } from '../../src/format/values.ts'
import { pathProblem, noteType } from '../../src/format/layout.ts'

const known: KnownName[] = [
  { name: 'Dana Whitfield', type: 'person' },
  { name: 'Jordan Kim', type: 'person' },
  { name: 'Q4 Launch', type: 'project' },
  { name: 'Board deck', type: 'link' },
]

describe('names', () => {
  it('accepts existing names, using their spelling', () => {
    assert.deepEqual(checkName('Dana Whitfield', known), {
      status: 'existing',
      name: 'Dana Whitfield',
      type: 'person',
    })
    assert.equal(checkName('dana whitfield', known).name, 'Dana Whitfield')
    assert.equal(checkName('Board deck', known).status, 'existing')
  })

  it('refuses close names with the closest matches', () => {
    for (const n of ['Dana Whitfeld', 'Dana Whitfield Jr', 'Dana', 'Jordan Kin', 'Q4 launches']) {
      const c = checkName(n, known)
      assert.equal(c.status, 'close', n)
      if (c.status === 'close') assert.ok(c.matches.length > 0)
    }
  })

  it('accepts genuinely new names', () => {
    for (const n of ['Lena Fischer', 'Sam Okafor', 'Partner API pilot']) {
      assert.equal(checkName(n, known).status, 'new', n)
    }
  })

  it('validates names as file names and links', () => {
    assert.equal(nameProblem('Dana Whitfield'), null)
    for (const bad of ['', ' Dana', 'a/b', 'a[b', 'a|b', '.hidden', 'x:y', 'a\nb']) {
      assert.notEqual(nameProblem(bad), null, bad)
    }
  })
})

describe('secrets', () => {
  it('finds common secrets', () => {
    for (const s of [
      'the wifi password is hunter2!',
      'Access code: 44178',
      'AKIAABCDEFGHIJKLMNOP',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxb-1234567890-abcdefghij',
      'sk-ant-abcdefghijklmnopqrstuvwxyz',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    ]) {
      assert.notEqual(findSecret(s), null, s)
    }
  })

  it('leaves ordinary sentences alone', () => {
    for (const s of [
      'Reset my password on the payroll site',
      'Ask Priya about the API key rotation policy',
      'Send the v3 pricing deck to Dana',
      'Token budget for the launch is $4k',
    ]) {
      assert.equal(findSecret(s), null, s)
    }
  })
})

describe('text', () => {
  it('normalizes links, fields, case and accents', () => {
    assert.equal(
      normalize('Send the deck to [[Dana Whitfield]] [due:: 2026-10-16]'),
      'send the deck to dana whitfield',
    )
    assert.equal(normalize('Café [Form](https://x.example.com)!'), 'cafe form')
  })

  it('matches phrases', () => {
    assert.equal(
      phraseMatches('send the deck to Dana', 'Send the deck to [[Dana Whitfield]]'),
      'contains',
    )
    assert.equal(phraseMatches('deck dana', 'Send the deck to [[Dana Whitfield]]'), 'words')
    assert.equal(phraseMatches('deck for Dana', 'Send the deck to [[Dana Whitfield]]'), null)
  })

  it('scores similar texts', () => {
    assert.equal(textSimilarity('Send the deck', 'send the deck!'), 1)
    assert.ok(textSimilarity('Send the v3 deck to Dana', 'Send the deck to Dana') > 0.8)
    assert.ok(textSimilarity('Book the venue', 'Send the deck to Dana') < 0.5)
  })
})

describe('values and paths', () => {
  it('checks real calendar dates', () => {
    assert.ok(isDate('2028-02-29'))
    assert.ok(!isDate('2026-02-29'))
    assert.ok(!isDate('2026-13-01'))
  })

  it('parses src', () => {
    assert.deepEqual(parseSrc('gmail 2026-10-12 https://mail.example.com/t/1'), {
      source: 'gmail',
      date: '2026-10-12',
      link: 'https://mail.example.com/t/1',
    })
    assert.deepEqual(parseSrc('cv'), { source: 'cv' })
    assert.equal(parseSrc('Carbon Voice'), null)
  })

  it('refuses paths outside the notebook', () => {
    assert.equal(pathProblem('people/Dana Whitfield.md'), null)
    for (const bad of [
      '../x.md',
      '/etc/x.md',
      'a/../b.md',
      '.git/config.md',
      'drafts/.history/a.md',
      'x.txt',
      'a\\b.md',
      '',
    ]) {
      assert.notEqual(pathProblem(bad), null, bad)
    }
  })

  it('knows note types', () => {
    assert.equal(noteType('people/Dana Whitfield.md'), 'person')
    assert.equal(noteType('log/2026-10-14.md'), 'log')
    assert.equal(noteType('archive/2026-10.md'), 'archive')
    assert.equal(noteType('log/consolidation.md'), 'other')
  })
})

describe('time zones', () => {
  it('computes today and the time in the notebook zone', () => {
    const at = new Date('2026-10-17T02:30:00Z')
    assert.deepEqual(zonedNow(at, 'America/New_York'), {
      date: '2026-10-16',
      time: '22:30',
      weekday: 'Friday',
      timezone: 'America/New_York',
    })
    assert.equal(zonedNow(at, 'Asia/Tokyo').date, '2026-10-17')
    assert.equal(zonedNow(new Date('2026-10-17T00:00:00Z'), 'UTC').time, '00:00')
  })
})
