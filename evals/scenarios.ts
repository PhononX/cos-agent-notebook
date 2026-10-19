// Scripted conversations, each with the notebook state it should produce. A scenario is what the
// person says, one exchange per turn; checks look at the notebooks afterwards. `ideal` is what a
// good agent would call: the tests replay it to prove each scenario's checks can pass, without a
// model.

import type { ItemKind } from '../src/format/layout.ts'
import type { CompactItem } from '../src/domain/service.ts'

export type Space = 'personal' | 'work'

/** What a check can see of the notebooks after the conversation. */
export interface View {
  items(
    space: Space,
    filter?: { kinds?: ItemKind[]; status?: 'open' | 'done' | 'all' },
  ): Promise<CompactItem[]>
  /** Note paths, like `people/Dana Whitfield.md`. */
  notes(space: Space): Promise<string[]>
}

export interface Check {
  name: string
  /** `filing` checks count toward "filed in the wrong place". */
  kind: 'state' | 'filing'
  /** true, or what was wrong. */
  test(view: View): Promise<true | string>
}

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface Scenario {
  name: string
  about: string
  turns: string[]
  checks: Check[]
  /** At most this many tool calls in any one exchange. */
  maxToolCalls: number
  /** At most this many successful writes over the conversation (asking before acting). */
  maxWrites?: number
  /** Tool calls a good agent makes, per turn. */
  ideal: ToolCall[][]
}

const OTHER: Record<Space, Space> = { personal: 'work', work: 'personal' }

const plain = (item: CompactItem) => item.text.replace(/\[\[|\]\]/g, '')

async function find(
  view: View,
  space: Space,
  kinds: ItemKind[] | undefined,
  pattern: RegExp,
  status: 'open' | 'done' | 'all' = 'all',
) {
  return (await view.items(space, { ...(kinds ? { kinds } : {}), status })).filter((i) =>
    pattern.test(plain(i)),
  )
}

/** An item matching `pattern` is in `space` and not in the other notebook. */
function filed(space: Space, kinds: ItemKind[] | undefined, pattern: RegExp): Check {
  return {
    name: `${kinds?.join('/') ?? 'item'} ${pattern} in the ${space} notebook`,
    kind: 'filing',
    async test(view) {
      const here = await find(view, space, kinds, pattern)
      const there = await find(view, OTHER[space], kinds, pattern)
      if (there.length) return `found in the ${OTHER[space]} notebook: ${plain(there[0]!)}`
      if (!here.length) return 'not found'
      return true
    },
  }
}

/** An item matching `pattern` in `space` satisfies `ok`. */
function item(
  name: string,
  space: Space,
  kinds: ItemKind[] | undefined,
  pattern: RegExp,
  ok: (i: CompactItem) => true | string,
): Check {
  return {
    name,
    kind: 'state',
    async test(view) {
      const found = await find(view, space, kinds, pattern)
      if (!found.length) return `no item matches ${pattern}`
      const results = found.map(ok)
      return results.find((r) => r === true) ?? results[0]!
    },
  }
}

/** Exactly `n` open items match `pattern`, across both notebooks. */
function openCount(name: string, pattern: RegExp, n: number): Check {
  return {
    name,
    kind: 'state',
    async test(view) {
      const all = [
        ...(await find(view, 'personal', undefined, pattern, 'open')),
        ...(await find(view, 'work', undefined, pattern, 'open')),
      ]
      return all.length === n ? true : `${all.length} open items match ${pattern}`
    },
  }
}

/** No note in either notebook has a path matching `pattern`. */
function noNote(name: string, pattern: RegExp): Check {
  return {
    name,
    kind: 'state',
    async test(view) {
      const all = [...(await view.notes('personal')), ...(await view.notes('work'))]
      const bad = all.find((p) => pattern.test(p))
      return bad ? `found ${bad}` : true
    },
  }
}

const due = (date: string) => (i: CompactItem) =>
  i.fields.due === date ? true : `due is ${String(i.fields.due ?? 'not set')}, expected ${date}`
const linksTo = (name: string) => (i: CompactItem) =>
  i.links.includes(name) ? true : `links ${JSON.stringify(i.links)}, expected ${name}`
const all =
  (...oks: ((i: CompactItem) => true | string)[]) =>
  (i: CompactItem) => {
    for (const ok of oks) {
      const r = ok(i)
      if (r !== true) return r
    }
    return true
  }

const PERSONAL = 'personal:alex:default'
const WORK = 'workspace:northwind:alex'
const session: ToolCall = { name: 'start_session', arguments: {} }

export const SCENARIOS: Scenario[] = [
  {
    name: 'capture-mixed',
    about:
      'One exchange yields a decision, an action and a personal reminder, across two notebooks',
    turns: [
      'Just got off a call with Dana. We decided the team tier drops to $18 per seat, to match competitors. I need to send her the new tier sheet by Tuesday. Unrelated: remind me to call Maya about her birthday dinner.',
    ],
    checks: [
      filed('work', ['decision'], /\$18/),
      filed('work', ['action'], /tier sheet/i),
      item(
        'the tier sheet action is due Tuesday and links Dana',
        'work',
        ['action'],
        /tier sheet/i,
        all(due('2026-10-20'), linksTo('Dana Whitfield')),
      ),
      filed('personal', ['action'], /Maya/),
      item(
        'the Maya action links Maya Okafor',
        'personal',
        ['action'],
        /Maya/,
        linksTo('Maya Okafor'),
      ),
    ],
    maxToolCalls: 4,
    ideal: [
      [
        session,
        {
          name: 'apply_changes',
          arguments: {
            notebook: WORK,
            operations: [
              {
                op: 'decide',
                text: 'Team tier drops to $18 per seat',
                person: 'Dana Whitfield',
                why: 'matches competitors',
                supersedes: { match: 'Team tier is $20 per seat' },
              },
              {
                op: 'add',
                kind: 'action',
                text: 'Send Dana Whitfield the new tier sheet',
                person: 'Dana Whitfield',
                due: '2026-10-20',
              },
            ],
          },
        },
        {
          name: 'apply_changes',
          arguments: {
            notebook: PERSONAL,
            operations: [
              {
                op: 'add',
                kind: 'action',
                text: 'Call Maya Okafor about her birthday dinner',
                person: 'Maya Okafor',
              },
            ],
          },
        },
      ],
    ],
  },
  {
    name: 'misheard-name',
    about: 'A voice transcript misspells a colleague; no new person is created',
    turns: [
      'Voice note: remind me to follow up with Dana Whitfeld about the launch date on Monday.',
    ],
    checks: [
      filed('work', ['action'], /launch date/i),
      item(
        'the action links Dana Whitfield and is due Monday',
        'work',
        ['action'],
        /launch date/i,
        all(linksTo('Dana Whitfield'), due('2026-10-19')),
      ),
      noNote('no note for the misheard name', /Whitfeld/),
    ],
    maxToolCalls: 3,
    ideal: [
      [
        session,
        {
          name: 'apply_changes',
          arguments: {
            notebook: WORK,
            operations: [
              {
                op: 'add',
                kind: 'action',
                text: 'Follow up with Dana Whitfield about the launch date',
                person: 'Dana Whitfield',
                due: '2026-10-19',
              },
            ],
          },
        },
      ],
    ],
  },
  {
    name: 'complete-by-phrase',
    about: 'The person says something is done; the agent checks off the existing item',
    turns: ['I sent the pricing deck to Dana this morning.'],
    checks: [
      item('the pricing deck action is done', 'work', ['action'], /pricing deck/i, (i) =>
        i.done === true ? true : 'still open',
      ),
      openCount('no open pricing deck items', /pricing deck/i, 0),
    ],
    maxToolCalls: 3,
    ideal: [
      [
        session,
        {
          name: 'apply_changes',
          arguments: {
            notebook: WORK,
            operations: [{ op: 'complete', match: 'pricing deck', file: 'actions.md' }],
          },
        },
      ],
    ],
  },
  {
    name: 'no-repeat',
    about: 'The person repeats themselves after a dropped line; the item is filed once',
    turns: [
      'Add a to-do: book the venue for the team offsite.',
      'Sorry, the line dropped. Did you get that? Book the venue for the team offsite.',
    ],
    checks: [filed('work', ['action'], /venue/i), openCount('one open venue item', /venue/i, 1)],
    maxToolCalls: 3,
    ideal: [
      [
        session,
        {
          name: 'apply_changes',
          arguments: {
            notebook: WORK,
            operations: [
              { op: 'add', kind: 'action', text: 'Book the venue for the team offsite' },
            ],
          },
        },
      ],
      [],
    ],
  },
  {
    name: 'file-by-space',
    about: 'A personal plan and a company fact in one breath go to different notebooks',
    turns: [
      "Two things to remember: I want to learn Portuguese next year. And Northwind's fiscal year starts in February.",
    ],
    checks: [filed('personal', undefined, /Portuguese/), filed('work', undefined, /fiscal year/i)],
    maxToolCalls: 4,
    ideal: [
      [
        session,
        {
          name: 'apply_changes',
          arguments: {
            notebook: PERSONAL,
            operations: [{ op: 'add', kind: 'idea', text: 'Learn Portuguese next year' }],
          },
        },
        {
          name: 'apply_changes',
          arguments: {
            notebook: WORK,
            operations: [
              { op: 'add', kind: 'fact', text: "Northwind's fiscal year starts in February" },
            ],
          },
        },
      ],
    ],
  },
  {
    name: 'ask-before-reorganizing',
    about: 'A question about overdue work is answered from reads, with no writes',
    turns: ["What's overdue at work?"],
    checks: [
      item('the pricing deck action is still open', 'work', ['action'], /pricing deck/i, (i) =>
        i.done === false ? true : 'it was changed',
      ),
    ],
    maxToolCalls: 3,
    maxWrites: 0,
    ideal: [[session, { name: 'get_review_candidates', arguments: { kinds: ['overdue'] } }]],
  },
]
