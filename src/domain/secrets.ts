// Passwords, access codes and keys never go in a notebook. These patterns catch the common ones;
// a refusal names the kind of secret, never the text.

const PATTERNS: [string, RegExp][] = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['a Slack token', /\bxox[abprse]-[A-Za-z0-9-]{10,}/],
  ['an API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe key', /\b[rsp]k_(?:live|test)_[0-9A-Za-z]{16,}\b/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'a password or access code',
    /\b(?:password|passwd|passcode|pass code|pin code|access code|api key|secret key|private key)s?\s*(?:is|was|=|:)\s*["'`]?[^\s"'`]{4,}/i,
  ],
]

/** What kind of secret the text seems to hold, or null. */
export function findSecret(text: string): string | null {
  for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) return kind
  return null
}
