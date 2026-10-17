import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextLines } from '../../src/format/lines.ts'

const cases = ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', 'a\r\nb\nc', '\n\n', '\r\n', 'x\n\n\ny']

describe('TextLines', () => {
  it('round-trips any text byte for byte', () => {
    for (const c of cases) assert.equal(TextLines.parse(c).toString(), c)
  })

  it('keeps the file without a final newline when appending', () => {
    assert.equal(TextLines.parse('a\nb').splice(2, 0, ['c']).toString(), 'a\nb\nc')
    assert.equal(TextLines.parse('a\nb\n').splice(2, 0, ['c']).toString(), 'a\nb\nc\n')
  })

  it("uses the file's own line ending for new lines", () => {
    assert.equal(TextLines.parse('a\r\nb\r\n').splice(1, 0, ['x']).toString(), 'a\r\nx\r\nb\r\n')
    assert.equal(TextLines.parse('a\r\nb').splice(2, 0, ['c']).toString(), 'a\r\nb\r\nc')
  })

  it('changes only the lines it touches', () => {
    const t = TextLines.parse('one\r\ntwo\nthree')
    assert.equal(t.splice(1, 1, ['TWO']).toString(), 'one\r\nTWO\nthree')
    assert.equal(t.splice(2, 1, ['3']).toString(), 'one\r\ntwo\n3')
    assert.equal(t.splice(1, 2, []).toString(), 'one')
    assert.equal(t.splice(0, 1, []).toString(), 'two\nthree')
  })
})
