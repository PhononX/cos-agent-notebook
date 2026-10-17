import { createHash, randomBytes } from 'node:crypto'

// Crockford's base 32 in lowercase: no i, l, o or u, so ids are easy to read aloud and type.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export const ITEM_ID = /^[0-9a-hjkmnp-tv-z]{6}$/

/**
 * An item's id: 6 characters from the SHA-256 of its note path, its exact line and how many
 * identical lines come before it in the note. See "Item id algorithm" in docs/notebook-format.md.
 */
export function itemId(path: string, line: string, occurrence: number): string {
  const hash = createHash('sha256').update(`${path}\n${line}\n${occurrence}`, 'utf8').digest()
  return base32(hash, 6)
}

/** A new change id, like `ch_7k2m9qxa`. */
export function newChangeId(): string {
  return `ch_${base32(randomBytes(5), 8)}`
}

export const CHANGE_ID = /^ch_[0-9a-hjkmnp-tv-z]{8}$/

function base32(bytes: Uint8Array, chars: number): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
    if (out.length >= chars) break
  }
  return out
}
