import { describe, it, expect } from 'vitest';
import { seedExperienceBank } from './AutofillSetupScreen';
import type { Profile } from '../lib/types';

// R-027: seedExperienceBank used to stamp the ENTIRE profile.skills array onto every bank entry
// as tags, for every user - the actual root cause of R-015's "seeded junk" (the same gRPC/SDK
// tag array on a Product Management internship and a VP of Finance role). Tags are supposed to
// say what THIS entry demonstrates; the setup UI collects none, so seeded entries must carry
// none. These tests pin that, in both directions: no stamping, and no other seeding regression.

const profile: Profile = {
  full_name: 'Mehek Mandal',
  email: 'mehekman@usc.edu',
  skills: ['Python', 'REST APIs', 'gRPC', 'SQL', 'Git', 'SDK design'],
  experience: [
    { company: 'SoFi', title: 'Product Management Intern', start: 'Jun 2025', end: 'Aug 2025', description: 'Shipped a thing.' },
    { company: 'Spark SC', title: 'VP of Finance', start: 'Jan 2025', end: 'May 2025', description: 'Ran the budget.' },
  ],
  projects: [{ name: 'Litos', description: 'Job application autofill extension.' }],
  school: 'USC',
  grad_year: 2028,
};

describe('R-027: seedExperienceBank does not stamp profile.skills onto entries', () => {
  it('seeds every entry with empty tags, never the skills array', () => {
    const bank = seedExperienceBank(profile);
    expect(bank).toHaveLength(3);
    for (const entry of bank) {
      expect(entry.tags).toEqual([]);
    }
  });

  it('never leaks any profile skill into any entry tags, even partially', () => {
    const bank = seedExperienceBank(profile);
    for (const entry of bank) {
      for (const skill of profile.skills) {
        expect(entry.tags).not.toContain(skill);
      }
    }
  });

  it('still seeds the entry content itself from the resume profile', () => {
    const bank = seedExperienceBank(profile);
    expect(bank[0]).toMatchObject({
      type: 'job',
      org: 'SoFi',
      title: 'Product Management Intern',
      bullet_variants: ['Shipped a thing.'],
    });
    expect(bank[2]).toMatchObject({
      type: 'project',
      org: 'Litos',
      bullet_variants: ['Job application autofill extension.'],
    });
  });
});
