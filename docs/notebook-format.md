# Notebook format

**Format version 1.** This document is a public contract. Agents, the dashboard, the
`cos-notebook` service and people editing in Obsidian all rely on it. A change that would make an
existing notebook read differently needs a new format version and a note under
[Changes](#changes).

The format started as the notes format of the Chief of Staff plugin in `PhononX/claude-plugins`
(`plugins/cos/skills/capture/notes-format.md`). This document keeps its layout, line and field
rules, and leaves out the guidance on how an agent should behave (when to capture, how to write a
brief). That guidance belongs in agent plugins, not in the format.

A notebook is a folder of plain Markdown. It opens as an Obsidian vault as it is: notes link with
`[[Name]]`, and extra details on a line use Dataview's inline field syntax, `[key:: value]`.

Dates are always `YYYY-MM-DD`. Times are 24-hour `HH:MM`, in the notebook's time zone (see
[my-rules.md](#my-rulesmd)).

## Layout

| File | What it holds |
|---|---|
| `now.md` | Focus (at most 3), this week's key dates, and suggested moves waiting for the person's answer |
| `brief.md` | Today's briefs, one section per brief; started fresh each day |
| `catch-up.md` | What needs the person's reply or attention in their email, chat and other channels |
| `nudges.md` | Short reminders to raise once, cleared after they're raised |
| `inbox.md` | Captured, not yet sorted |
| `actions.md` | What the person owes, plus pointers to to-do lists kept in other tools |
| `waiting.md` | What other people owe the person |
| `ideas.md` | Ideas and "that thing I mentioned once", with when to bring each back |
| `links.md` | Links worth finding again |
| `facts.md` | Loose facts worth finding again |
| `decisions.md` | What was decided, why, and with whom |
| `drafts/<Name>.md` | One note per piece of writing being shaped: an email, document, deck, message or post |
| `drafts/.history/<Name>/v<N>.md` | Earlier versions of a draft |
| `projects/<Name>.md` | One note per project: an outcome with an end |
| `areas/<Name>.md` | One note per ongoing responsibility, which never "finishes" |
| `people/<Name>.md` | One note per person |
| `log/YYYY-MM-DD.md` | One note per day: what was captured and changed |
| `archive/YYYY-MM.md` | Finished, dropped and stale items, each with the reason |
| `my-rules.md` | The person's own rules and settings. These win over the defaults |
| `about-me.md` | What the agent knows about the person, told and learned |
| `sources.md` | Where the person's conversations and to-dos happen, and what the agent reads in each |

Other `.md` files may exist (for example `log/consolidation.md`). They are read as free notes:
their list lines are items like any other, but no rules beyond [Lines](#lines) apply to them.

Folders and files whose names start with `.` are not notes, with one exception: draft history in
`drafts/.history/`, which is kept but not shown as notes. Only `.md` files are notes.

### Names

Names of notes are the plain name, as people say it: `people/Dana Whitfield.md`,
`projects/Q4 Launch.md`. Links use that name exactly: `[[Dana Whitfield]]`. A link with no note
yet is allowed. Link only names: never `[[Today]]`, `[[Monday]]` or other words.

A name is one line, at most 100 characters, and can't contain any of `[ ] | # ^ / \ : * ? " < >`
or start with `.`, so it is always a valid file name and a valid link.

## Lines

Most files are lists. One item per line, starting `- ` (or `* `, or `1. ` for numbered lists).
The plain sentence comes first, then the fields. Links to people, projects and areas go inside the
sentence, where they read naturally.

```
- [ ] Send the v3 pricing deck to [[Dana Whitfield]] for [[Q4 Launch]] [due:: 2026-10-16] [src:: cv 2026-10-13]
```

The parts of an item line, in order:

1. Optional indentation (spaces or tabs). An indented item is an item like any other.
2. The list marker: `- `, `* `, or a number and a dot (`1. `).
3. Optional checkbox: `[ ] ` (open) or `[x] ` (done; `[X]` is read the same).
4. The sentence: plain text with `[[links]]` and Markdown links (`[label](https://…)`).
5. Zero or more fields, `[key:: value]`, separated by single spaces.

An item can carry indented quote lines directly beneath it, for what the person actually said or
for a draft. Quote lines are indented (any amount) and start with `>`:

```
- A referral program: a free seat for each team a customer brings in [back:: when v3 pricing is set] [src:: cv 2026-10-02]
  > Remind me about the free-seat referral thing once pricing's done.
```

Lines that aren't list items (headings, paragraphs, blank lines, front matter) are kept as they
are. Lines inside fenced code blocks (between ```` ``` ```` lines) are never items.

### Fields

A field is `[key:: value]`, with exactly two colons and one space after them. Keys are lowercase
letters, digits and `_`, starting with a letter. A value can contain `[[links]]` but no other
square brackets. A key may repeat on one line; `src` is the only key that is repeated in
practice, when duplicate items were merged and each source is kept.

| Field | Used in | Value |
|---|---|---|
| `due` | actions | `YYYY-MM-DD` |
| `since` | waiting, catch-up | the date it started waiting |
| `nudged` | waiting | the last date the person was reminded |
| `back` | ideas | when to bring it back, in words ("when v3 pricing is set") or a date |
| `why` | decisions, archive | the reason, in one short phrase |
| `superseded` | decisions | the date a later decision replaced this one |
| `done` | actions, waiting | the date it was finished |
| `archived` | archive | the date it was archived |
| `from` | archive | the note it came from, without `.md`, like `actions` or `people/Dana Whitfield` |
| `prep` | brief meetings | `ready`, `offered`, or `HH:MM` when prep will be sent |
| `sent` | brief headings | the time that brief was sent, `HH:MM` |
| `kind` | catch-up | `reply` (someone asked the person something), `missed` (unread or unanswered and worth seeing), or `changed` (news that moves a project, action or waiting item) |
| `raised` | catch-up | how many briefs have mentioned it, a whole number |
| `at`, `days`, `covers` | my-rules briefs | a brief's time (`HH:MM`), its days, and what it covers |
| `src` | anything | where it came from: `<source> <YYYY-MM-DD>`, then a link if there is one |
| `replaces` | my-rules rules | the id of the default it replaces |
| `status`, `via`, `reads` | sources | connected or not, through what, and what the agent reads there |
| `for` | my-rules tools, about-me writing | the kind of work: `email`, `doc`, `deck`, `slack`, `text`, `post`, `notes`, or another word |
| `audience` | about-me writing | who it's written to: `colleagues`, `team`, `executives`, `clients`, `friends`, `family`, or another word |
| `by` | log | who made the change: the client and the person it acted for, or `outside the service` for edits made directly to the files |
| `change` | log | the id of the change, for undo |

Fields not in this table are allowed and kept as they are.

`src` sources are short, lowercase names: `cv` (Carbon Voice), `gmail`, `cal`, `slack`,
`linear`, `asana`, `notion`, `jira`, `drive`, `file` (a file on the person's computer),
`onboarding`, `page` (the person changed it on the dashboard), or the name of another tool. A link
to the original message follows the date when there is one:
`[src:: gmail 2026-10-12 https://mail.example.com/thread/18c2f]`.

### Item ids

Every item has a short id of 6 characters (digits and lowercase letters), derived from its note's
path and the exact text of its line, plus an occurrence number when identical lines repeat in one
note. Ids are never written into the files. An id stays the same until its line changes; a tool
that changes a line returns the line's new id. See [Item ids](#item-id-algorithm) below for the
exact rule.

### Front matter

People, projects, areas, drafts, `brief.md` and `my-rules.md` start with front matter: a `---`
line, one `key: value` per line, and a closing `---` line. Front matter is a small subset of YAML:

- Keys are lowercase letters, digits and `_`, starting with a letter.
- A value is plain text to the end of the line, or a double-quoted string (`"[[Jordan Kim]]"`)
  when it contains `:`, `#`, starts with `[`, `{`, `"`, `'` or `>`, or has spaces at either end.
  Inside double quotes, `\"` and `\\` are the only escapes.
- No nesting, lists or multi-line values. Comment lines start with `#`.

## Each file

**actions.md**
```
# My actions

## To do
- [ ] Reply to [[Jordan Kim]] with Q3 churn numbers [due:: 2026-10-14] [src:: gmail 2026-10-12]
- [x] Send Q3 roadmap recap to the team [done:: 2026-10-12] [src:: cv 2026-10-08]

## Elsewhere
- Linear: issues assigned to me [via:: claude.ai connector]
- Asana: Marketing launch board, my tasks [via:: claude.ai connector]
```
"Elsewhere" points to to-do lists the person keeps in other tools; their items aren't copied here.

**waiting.md**: the person's link comes first, then a colon.
```
# Waiting on others

- [ ] [[Priya Natarajan]]: engineering estimate for usage-based billing [since:: 2026-10-06] [nudged:: 2026-10-10] [src:: cv 2026-10-06]
```

**decisions.md**: the date comes first. A past decision is never edited; it is marked
`superseded` when a later one replaces it.
```
# Decisions

- 2026-10-09 Team tier drops to $18 per seat, with a 10-seat minimum, agreed with [[Dana Whitfield]] [why:: matches the two closest competitors] [src:: cv 2026-10-09]
```

**links.md**: a Markdown link, then context.
```
# Links

- [Customer beta signup form](https://forms.example.com/v3-beta) for [[Q4 Launch]] [src:: slack 2026-10-03]
```

**facts.md**
```
# Facts

- Acme has 340 seats, and the renewal date is Dec 1, for [[Acme Logistics renewal]] [src:: gmail 2026-09-29]
```
A fact about one person goes in that person's note; one about one project goes in the project's
note. `facts.md` holds the rest. Passwords, access codes and keys never go anywhere in a notebook.

**inbox.md**, **ideas.md**: plain lines with `src`, and `back` for ideas.
```
# Inbox

- Stripe sent a new invoice format; check whether it affects the billing page [src:: cv 2026-10-13]
```
```
# Come back to

- A referral program: a free seat for each team a customer brings in [back:: when v3 pricing is set] [src:: cv 2026-10-02]
```

**nudges.md**: short reminders, one sentence each, raised once and then cleared.
```
# Nudges

- [[Jordan Kim]] has been waiting 3 days on the churn numbers [src:: gmail 2026-10-12]
```

**archive/YYYY-MM.md**: lines move here with the reason. Nothing is ever deleted. The month is
the month the item was archived. `archived`, `why` and `from` go before `src`.
```
# Archive: October 2026

- [x] Look into the conference sponsorship for March [archived:: 2026-10-12] [why:: no mention for 30 days] [from:: actions] [src:: cv 2026-09-10]
```

**now.md**
```
# Now

## Focus
- Lock v3 pricing before Friday's [[Q4 Launch]] review

## This week
- 2026-10-16 Pricing review with [[Dana Whitfield]]

## Suggested moves
- The referral idea has come up three times. Make it a project? [src:: cv 2026-10-14]
```
"Focus" has at most 3 lines. "This week" lines start with a date. "Suggested moves" are proposals
the person hasn't agreed to yet: an inbox item to file, an idea to promote into a project, a
project to close. Each is removed once the person answers.

**brief.md**: one section per brief sent today, under the brief's name and the time it was
sent. The first brief of the day starts the file again.
```
---
date: 2026-10-15
---
# Briefs for Thursday, October 15

## Morning brief [sent:: 07:02]

### Focus
- Lock v3 pricing before Friday's [[Q4 Launch]] review

### Meetings
- 09:30 Pricing review with [[Dana Whitfield]] and [[Priya Natarajan]] [prep:: ready]
  > The three open questions on the Team tier, and Dana's discount ask from Tuesday.
- 13:00 Acme renewal call with [[Lena Fischer]] [prep:: 12:45]

### Catch up
- [[Jordan Kim]] asked for the Q3 churn numbers [kind:: reply] [since:: 2026-10-12] [src:: gmail 2026-10-12 https://mail.example.com/thread/18c2f]

### Follow-ups
1. Send the v3 pricing deck to [[Dana Whitfield]] [src:: cv 2026-10-13]
   > Dana, here's the v3 deck. Slide 6 has the Team tier change we talked about.
2. Answer [[Jordan Kim]]'s question on Q3 churn [src:: gmail 2026-10-12]
   > Jordan, Q3 logo churn was 2.1%, down from 2.8%.

## Midday check-in [sent:: 12:31]

### Follow-ups
1. Tell [[Priya Natarajan]] SSO can ship Thursday [src:: slack 2026-10-15]
   > Yes, ship it Thursday.
```
Each brief is a `##` heading with `sent`. Section names inside a brief are free `###` headings
(Focus, Meetings, Catch up, Follow-ups, Due elsewhere, This week, Done this week, …); empty ones
are left out. Follow-ups are a numbered list, numbered from 1 in each brief; the numbers always
mean the latest brief. The quote under each follow-up is its draft.

**catch-up.md**: what needs the person's reply or attention, one line per thread, linking to it.
```
# Catch up

## Needs your reply
- [[Jordan Kim]] asked for the Q3 churn numbers [kind:: reply] [since:: 2026-10-12] [raised:: 2] [src:: gmail 2026-10-12 https://mail.example.com/thread/18c2f]

## You may have missed
- Three unread emails from [[Lena Fischer]] about seat counts [kind:: missed] [since:: 2026-10-14] [raised:: 1] [src:: gmail 2026-10-14 https://mail.example.com/thread/19a07]

## Changed
- Acme moved the renewal call to Dec 3, for [[Acme Logistics renewal]] [kind:: changed] [since:: 2026-10-14] [raised:: 1] [src:: gmail 2026-10-14]
```
`kind` decides the section: `reply` under "Needs your reply", `missed` under "You may have
missed", `changed` under "Changed". A line that's dealt with moves to the archive with the reason
(`why:: replied`, `why:: skipped`).

**people/<Name>.md**, **projects/<Name>.md**, **areas/<Name>.md** start with front matter, then
a `# Name` heading, then free Markdown. Everything that links to the note belongs to it, so those
items aren't repeated in the note.
```
---
role: Head of Sales
org: Northwind
last_talked: 2026-10-13
rhythm: Weekly pricing sync, Thursdays
---
# Dana Whitfield

- Prefers a short written summary before any pricing meeting [src:: cv 2026-10-09]
```
```
---
status: active
due: 2026-11-18
area: Product
---
# Q4 Launch

## Outcome
v3 pricing and the new onboarding live for all customers.

## Next
- Lock v3 pricing at Thursday's review

## Notes
- A referral program: a free seat for each team a customer brings in [back:: when v3 pricing is set] [src:: cv 2026-10-02]
```
Person front matter: `role`, `org`, `last_talked` (a date), `rhythm`, and others as needed.
Project `status` is `active`, `paused`, `done` or `dropped`; `due` is a date; `area` names an
area. A finished project keeps its note with `status: done` and a line saying how it ended.
Areas have no status or due date. An idea promoted into a project moves into its "Notes" section.

**drafts/<Name>.md**: a piece of writing while it's being shaped. Front matter, then the draft,
then the notes it was built from, then its history.
```
---
kind: doc
status: draft
horizon: soon
for: "[[Jordan Kim]]"
project: "[[Board deck]]"
due: 2026-11-06
version: 3
touched: 2026-10-15
---
# Board narrative

## Draft
Q3 was the quarter we stopped losing small teams…

## Notes
- Lead with the churn number, then the two big losses [src:: cv 2026-10-14]
  > Start with churn, Jordan always asks about it first.

## History
- v3 2026-10-15 shorter opening, churn first [src:: cv 2026-10-15]
- v2 2026-10-14 first full draft
- v1 2026-10-12 outline
```
- `kind` is `email`, `doc`, `deck`, `message`, `post` or another word. `for` and `project` link
  the person and project it's for.
- `horizon` is `soon` (needed in days or weeks) or `long` (built over time).
- `status` is one of `notes` → `outline` → `draft` → `ready` → `moved`, `done` or `dropped`.
- `version` is a whole number; `touched` is the last date the person worked on it.
- Each new version replaces the "Draft" section; the version before it is kept as
  `drafts/.history/<Name>/v<N>.md`, and "History" gets one line saying what changed.
- For a deck, the draft is slide by slide: `### 1. Title` then the slide's points, with
  `> Speaker notes:` under each slide.
- When it moves to another tool, the front matter gets `moved_to` (the tool) and `link` (the
  address of the copy there), and `status: moved`.

**my-rules.md**: settings in the front matter, rules and preferences as lines. A rule that
changes a default names it with `replaces`.
```
---
timezone: America/New_York
nudges_per_day: 3
stale_days: 30
meeting_prep: offer
---
# My rules for Ada

## My rules
- Drafts should sound like me: plain, short, no exclamation marks [src:: cv 2026-10-04]

## Where things go
- Team tasks live in Linear. Point to them; don't copy them [replaces:: todos] [src:: cv 2026-10-13]

## My briefs
- Morning brief [at:: 06:45] [days:: weekdays] [covers:: focus, meetings, catch up, follow-ups, due elsewhere] [src:: cv 2026-10-05]
- Friday wrap-up [at:: 16:30] [days:: fri] [covers:: what got done, what slipped, next week] [src:: cv 2026-10-09]

## What goes in my briefs
- Keep each brief under a minute [src:: onboarding 2026-10-01]

## Important people
- [[Jordan Kim]]: anything from him, always [src:: onboarding 2026-10-01]

## My tools
- Emails: Gmail, as drafts [for:: email] [src:: cv 2026-10-15]
- Documents: Google Docs, in the "Northwind" folder [for:: doc] [src:: cv 2026-10-12]
```
Settings:

| Setting | Value |
|---|---|
| `timezone` | The notebook's time zone, an IANA name like `Europe/Berlin`. "Today", "overdue", "stale", log dates and times are all computed in it. When it's missing, the service's configured default applies (in local mode, the computer's time zone). |
| `nudges_per_day` | A whole number |
| `stale_days` | A whole number: items untouched this many days are stale |
| `meeting_prep` | `offer`, `auto` or `off` |

**My briefs** has one line per brief: its name, then `at` (`HH:MM`), `days` (`weekdays`,
`daily`, `weekends`, `off`, or days like `mon, wed, fri`) and `covers`. An older file may have
`brief_time` and `brief_days` in its front matter and no "My briefs" section; that means a single
"Morning brief" at that time on those days.

**about-me.md**
```
# About me

## Role
- VP of Product at Northwind [src:: onboarding 2026-10-01]

## How I write
- Short and direct, two to four sentences; signs off "– Alex" [for:: email] [audience:: colleagues] [src:: gmail 2026-10-02]

## Learned
- Talks through decisions on walks, usually 8 to 8:30am [src:: cv 2026-10-10]
```
"Learned" holds what was noticed rather than told. "How I write" has one line per kind of writing
and audience, with `for` and `audience`.

**sources.md**
```
# Where I talk

- Carbon Voice [status:: connected] [via:: the Carbon Voice connector] [reads:: messages to me]
- Notion [status:: not connected] [reads:: where your specs live]
```

**log/YYYY-MM-DD.md**: one line per event, starting with the time.
```
# 2026-10-14

- 09:12 Captured: Lena raised uptime credits again; draft an offer by Friday [src:: cv 2026-10-14]
- 14:03 Added "Send the deck to [[Dana Whitfield]]" to actions.md [by:: claude-desktop for Alex] [change:: ch_7k2m9qxa]
```
The service adds one line for every change it makes, with `by` and `change`, so anyone reading
the log sees changes made by people and by other agents.

## Reading and writing rules

- **Lossless.** Reading a file and writing it back unchanged gives identical bytes, including
  line endings (`\n` or `\r\n`), a missing final newline and anything that doesn't fit the format.
  An edit changes only the lines it touches.
- **Tolerant reading.** A hand-edited line that doesn't fit the format is read as well as it can
  be and reported as a problem (with its line number), never dropped or rewritten.
- **Strict writing.** Every line the service writes fits the format: the sentence first, fields
  after it with `src` last, valid dates and times, valid names, one line per item.
- **No secrets.** Writes that look like passwords, access codes, private keys or API tokens are
  refused.

## Item id algorithm

For an item on line *L* (the full line, without its line ending) in the note at path *P*
(relative to the notebook, using `/`), where *L* has appeared *n* times earlier in the same note
(so *n* is 0 for the first occurrence):

1. Take the SHA-256 hash of the UTF-8 bytes of *P*, a newline, *L*, a newline and *n* in decimal.
2. Read the first 30 bits of the hash as five-bit groups, most significant bit first.
3. Write each group as one character of `0123456789abcdefghjkmnpqrstvwxyz`.

The id therefore changes when the line's text changes, when the item moves to another note, or
when an identical line is added above it.

## Changes

- **Version 1** (from the Chief of Staff plugin's notes format): adds `timezone` to
  `my-rules.md`, the `by` and `change` log fields, repeated `src`, item ids, the front matter
  subset, and the name rules.
