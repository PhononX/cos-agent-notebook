// The notebooks every evaluation starts from: Alex's personal notebook and their work notebook at
// Northwind, a little lived in. Everyone and everything here is invented.

import type { Actor } from '../src/domain/actor.ts'
import { personalNotebook, workspaceNotebook } from '../src/domain/notebook-ref.ts'
import type { NotebookService } from '../src/domain/service.ts'

export const PERSONAL = personalNotebook('alex')
export const WORK = workspaceNotebook('northwind', 'alex')
export const TIMEZONE = 'America/New_York'

/** 10:05 on Saturday 2026-10-17 in New York. "Tuesday" is 2026-10-20. */
export const NOW = new Date('2026-10-17T14:05:00Z')

const SEEDER: Actor = { client: 'eval-seed', person: 'Alex', source: 'cv' }

export async function seedNotebooks(service: NotebookService): Promise<void> {
  await service.init(PERSONAL, { actor: SEEDER, timezone: TIMEZONE })
  await service.init(WORK, { actor: SEEDER, timezone: TIMEZONE })

  await service.applyChanges(
    PERSONAL,
    {
      operations: [
        {
          op: 'note',
          type: 'person',
          name: 'Maya Okafor',
          front_matter: { role: 'Sister' },
          append: ['Lives in Portland; birthday is November 2'],
        },
        { op: 'note', type: 'project', name: 'Kitchen renovation', append: ['Budget is $30k'] },
        { op: 'add', kind: 'action', text: 'Book the dentist', due: '2026-10-23' },
        {
          op: 'add',
          kind: 'action',
          text: 'Get a second quote for the cabinets',
          project: 'Kitchen renovation',
        },
        { op: 'add', kind: 'idea', text: 'Take a pottery class this winter' },
        {
          op: 'note',
          type: 'person',
          name: 'Dana Whitfield',
          same_as: [{ notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' }],
        },
      ],
    },
    SEEDER,
  )

  await service.applyChanges(
    WORK,
    {
      operations: [
        {
          op: 'note',
          type: 'person',
          name: 'Dana Whitfield',
          front_matter: { role: 'VP Sales' },
          append: ['Alex reports to Dana'],
        },
        {
          op: 'note',
          type: 'person',
          name: 'Theo Brandt',
          front_matter: { role: 'Engineering lead' },
        },
        {
          op: 'note',
          type: 'project',
          name: 'Q4 Launch',
          append: ['Launch date is November 12'],
        },
        {
          op: 'add',
          kind: 'action',
          text: 'Send the v3 pricing deck to Dana Whitfield',
          person: 'Dana Whitfield',
          project: 'Q4 Launch',
          due: '2026-10-16',
          src: 'cv 2026-10-13',
        },
        {
          op: 'add',
          kind: 'waiting',
          text: 'the engineering estimate for SSO',
          person: 'Theo Brandt',
          project: 'Q4 Launch',
          since: '2026-10-12',
          src: 'slack 2026-10-12',
        },
        {
          op: 'decide',
          text: 'Team tier is $20 per seat',
          person: 'Dana Whitfield',
          src: 'cv 2026-09-30',
        },
      ],
    },
    SEEDER,
  )
}
