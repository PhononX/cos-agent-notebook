# Where things belong: personal and workspace notebooks

A person can have a personal notebook and a separate work notebook in each workspace they belong
to (see "Personal and workspace notebooks" in `SPEC.md`). This page says what goes where. Agents
follow it when they file anything. The service can't judge content and doesn't try; it keeps the
notebooks apart and publishes these rules.

People keep work and personal apart even when no company is watching, so the same rules apply to
a freelancer's own business or a side project: the workspace is still a separate bucket, just one
the person controls on both sides.

## The test

**Whose business is it?** The company's business goes in the workspace notebook. Yours, as a
person, goes in your personal notebook.

Two questions settle most cases:

1. **Would it be wrong to take this with you when you leave?** Then it's the workspace's.
2. **Would it be wrong for your employer to read, keep or delete it?** Then it's yours.

**When it isn't clear, ask the person.** The channel something arrived through (work email, a
personal text) is a hint, never the decision. Don't guess, and don't file it in both.

## Workspace: what a company cares about, and what stays

- **Confidential business:** strategy, financials, pricing, roadmaps, unreleased plans, deals,
  legal matters.
- **Customers and partners:** who they are in a business context, contract terms, renewals,
  issues, anything under an NDA.
- **Work product:** drafts, decks, documents, meeting notes, and decisions made at work with their
  reasons.
- **Work commitments:** what the person owes or is owed in their role: actions, waiting items,
  follow-ups.
- **Colleagues in their work role:** role, projects, positions, how they work with the person.
- **Other people's HR matters:** performance, pay, complaints. Especially sensitive.
- **Work projects and areas.**

## Personal: what's yours, and travels with you

- **You:** preferences, how you work and write, your rules, and your life: health, family, money,
  home, interests.
- **Your career:** goals, feedback you received, your own pay and reviews, and your accomplishments
  described without confidential detail ("led the v3 pricing launch", not the numbers).
- **Your relationships as people:** that you know someone, how to reach them outside work, their
  family, your history together across jobs. Your network. See "People in both".
- **General know-how:** lessons stated without confidential facts ("sales needs pricing changes two
  weeks early").
- **Personal commitments, plans and ideas** that aren't about the employer's business.

## Gray areas

- **Your own employment is personal**, even though it's about work: a job search, a raise
  negotiation, your own review, a complaint you are making. This must never sit in employer
  storage.
- **Mixed items are split, never copied.** "Lunch with Dana on Friday about the renewal" is an
  action in the work notebook; if the friendship matters, "caught up with Dana" can go in the
  personal note.
- **A colleague who becomes a friend:** the friendship is personal; their work context stays at
  work.
- **Ideas about the employer's business that came up on the job** belong to the workspace, as most
  employment agreements treat them. Unrelated ideas are yours.
- **Calendar:** work meetings at work, personal appointments personal.

## People in both

The personal notebook has a note for everyone the person deals with in any space. For a colleague
it can be just a name and a `same_as` pointer to their note in each work notebook, and it grows only
with what comes in outside work. What's learned at work goes into the work note. Links live only in
the personal notebook, so no workspace learns about the person's other spaces.

## Mistakes

Something personal filed in a work notebook stays in that workspace's history until a workspace
admin purges it, the same as personal mail sent to a work address. The member can archive or
correct the item, but can't purge it, because a member who could purge their own items could also
clear work records. This is why the agent asks when it isn't sure.

The other way round is the person's to fix. Work content filed in the personal notebook by mistake
is refiled: the agent adds it to the right work notebook first, then, with the person's approval,
purges it from the personal notebook, history included, so the person doesn't keep company
information outside the workspace. The person can purge anything from their own notebook at any
time.

## Rules that win over these

- **The person's own:** under "Where things go" in their personal `my-rules.md` ("anything about my
  side project goes personal").
- **The workspace's:** a workspace can set rules for all its notebooks ("never record HR matters
  here"). These arrive with workspace administration in milestone 6.

Where the two disagree about something in a work notebook, the workspace's rule wins; the person
can always choose to keep a thing out of the work notebook altogether.
