// A file as a list of lines that remembers each line's own ending, so that joining them back
// gives the original bytes: `\n` or `\r\n` per line, and whether the file ended with a newline.

export type Eol = '\n' | '\r\n'

export class TextLines {
  private readonly content: string[]
  private readonly ends: string[]

  private constructor(content: string[], ends: string[]) {
    this.content = content
    this.ends = ends
  }

  static parse(text: string): TextLines {
    const content: string[] = []
    const ends: string[] = []
    let start = 0
    while (start < text.length) {
      const nl = text.indexOf('\n', start)
      if (nl < 0) {
        content.push(text.slice(start))
        ends.push('')
        break
      }
      const cr = nl > start && text[nl - 1] === '\r'
      content.push(text.slice(start, cr ? nl - 1 : nl))
      ends.push(cr ? '\r\n' : '\n')
      start = nl + 1
    }
    return new TextLines(content, ends)
  }

  static from(lines: string[], eol: Eol = '\n'): TextLines {
    return new TextLines(
      [...lines],
      lines.map(() => eol),
    )
  }

  get length(): number {
    return this.content.length
  }

  line(i: number): string {
    const l = this.content[i]
    if (l === undefined) throw new RangeError(`No line ${i}`)
    return l
  }

  lines(): readonly string[] {
    return this.content
  }

  /** The line ending most lines use, for lines this file gains. */
  get eol(): Eol {
    let crlf = 0
    let lf = 0
    for (const e of this.ends) {
      if (e === '\r\n') crlf++
      else if (e === '\n') lf++
    }
    return crlf > lf ? '\r\n' : '\n'
  }

  toString(): string {
    let out = ''
    for (let i = 0; i < this.content.length; i++) out += this.content[i]! + this.ends[i]!
    return out
  }

  /** Replaces `count` lines from `start` with `lines`, keeping every other line's bytes. */
  splice(start: number, count: number, lines: readonly string[]): TextLines {
    if (
      start < 0 ||
      start > this.content.length ||
      count < 0 ||
      start + count > this.content.length
    ) {
      throw new RangeError(`Bad splice ${start}+${count} of ${this.content.length}`)
    }
    const eol = this.eol
    const content = [...this.content]
    const ends = [...this.ends]
    const removedLast = start + count === this.content.length
    const lastEnd = removedLast && count > 0 ? ends[start + count - 1]! : undefined
    // A line replaced in place keeps its own ending; added lines get the file's usual one.
    const newEnds = lines.map((_, i) =>
      i < count - (removedLast ? 1 : 0) ? ends[start + i]! : eol,
    )
    content.splice(start, count, ...lines)
    ends.splice(start, count, ...newEnds)
    const end = start + lines.length
    if (lines.length > 0) {
      if (removedLast && lastEnd !== undefined) {
        // The new lines replace the file's last lines: they inherit its final ending.
        ends[end - 1] = lastEnd
      } else if (end === content.length && start > 0 && ends[start - 1] === '') {
        // Appending after a last line that had no newline: that line now needs one, and the
        // new last line goes without, as the file did.
        ends[start - 1] = eol
        ends[end - 1] = ''
      }
    } else if (removedLast && start > 0 && lastEnd === '') {
      ends[start - 1] = ''
    }
    return new TextLines(content, ends)
  }
}
