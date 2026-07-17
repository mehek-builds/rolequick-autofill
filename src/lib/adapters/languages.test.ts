import { describe, it, expect } from 'vitest';
import {
  languageQuestion,
  languageAnswerPlan,
  languageSkipReason,
  matchOption,
} from './generic';
import { skippedReasonsNeedReview } from '../autosubmit-gate';
import type { ApplicationProfile } from '../types';

// The language classifier and its answer plan are pure (no DOM), and they sit one regex away
// from two standing failure classes: answering a work-eligibility question (R-004's shape - the
// nationality adjectives ARE language names) and fabricating a claim the student never made
// (R-015's shape, re-expressed as spoken fluency). These tests pin the two LIVE phrasings the
// feature was built for, the declared-list semantics in both directions, and the refusal
// precedence that must survive any future edit.

const ap = (o: Partial<ApplicationProfile> = {}): ApplicationProfile => o as ApplicationProfile;
// Mehek's real declared list (2026-07-17): the authority for language questions.
const declared = ['English', 'Hindi', 'Arabic', 'French'];
const opts = (...texts: string[]) => texts.map((text) => ({ text }));

// The live ZURU label, verbatim (2026-07-17): a radio Yes/No whose container text carries the
// whole preamble, which is exactly what the adapters pass as the label.
const ZURU =
  'This role involves working closely with our team in Mexico, so Spanish language skills are ' +
  'preferred but not essential. Are you comfortable communicating in Spanish in a professional setting?';

describe('languageQuestion: classification', () => {
  it('classifies the live ZURU phrasing as a yes/no Spanish question', () => {
    expect(languageQuestion(ZURU)).toEqual({ kind: 'yesno', languages: ['spanish'] });
  });

  it('classifies the live Enpal-style level phrasings', () => {
    // The German compound fuses the language into one word - no \b boundary exists inside
    // "Deutschkenntnisse", which is why the classifier has a dedicated compound matcher.
    expect(languageQuestion('Wie gut sind deine Deutschkenntnisse?')).toEqual({
      kind: 'level',
      languages: ['german'],
    });
    expect(languageQuestion('German level')).toEqual({ kind: 'level', languages: ['german'] });
    expect(languageQuestion('English level')).toEqual({ kind: 'level', languages: ['english'] });
  });

  it('classifies the standard yes/no fluency phrasings', () => {
    expect(languageQuestion('Are you fluent in German?')).toEqual({ kind: 'yesno', languages: ['german'] });
    expect(languageQuestion('What is your proficiency in French?')).toEqual({
      kind: 'yesno',
      languages: ['french'],
    });
    expect(languageQuestion('Do you speak Hindi?')).toEqual({ kind: 'yesno', languages: ['hindi'] });
    expect(languageQuestion('Arabic language skills required')).toEqual({
      kind: 'yesno',
      languages: ['arabic'],
    });
  });

  it('matches native language names ("niveau de francais", diacritics stripped)', () => {
    expect(languageQuestion('Niveau de Français')).toEqual({ kind: 'level', languages: ['french'] });
  });

  it('NEVER matches a programming-language question', () => {
    expect(languageQuestion('What is your preferred programming language?')).toBeNull();
    expect(languageQuestion('Which programming languages do you know? Please answer in English')).toBeNull();
  });

  it('NEVER matches a count question ("how many languages do you speak")', () => {
    expect(languageQuestion('How many languages do you speak?')).toBeNull();
  });

  it('does not classify a label that merely CONTAINS a language name with no proficiency ask', () => {
    // "polish" the verb, and a perk blurb naming a language: neither is a proficiency question.
    expect(languageQuestion('How would you polish our onboarding flow?')).toBeNull();
    expect(languageQuestion('Why do you want to join our German office?')).toBeNull();
  });

  it('REFUSAL PRECEDENCE: a work-eligibility label can never classify as a language question', () => {
    // R-004's exact shape: the legal question names a country whose adjective is a language.
    expect(
      languageQuestion('Are you legally authorized to work in Spain and comfortable communicating in Spanish?'),
    ).toBeNull();
    expect(languageQuestion('Do you require visa sponsorship to work with our Spanish team?')).toBeNull();
  });

  it('REFUSAL PRECEDENCE: citizenship/nationality labels can never classify as language questions', () => {
    // Nationality adjectives ARE language names; this label must keep resolving through
    // classifyField (citizenship), never through a fluency rule.
    expect(languageQuestion('What is your nationality? e.g. Spanish, German, French speaker')).toBeNull();
  });

  it('REFUSAL PRECEDENCE: an EEO label can never classify as a language question', () => {
    expect(languageQuestion('Which ethnicity do you identify with? Spanish / Portuguese / Other')).toBeNull();
  });
});

describe('languageAnswerPlan: declared-list semantics', () => {
  it('ZURU with the real declared list (no Spanish): fills No, review-flagged, and the flag HOLDS auto-submit', () => {
    const plan = languageAnswerPlan(ZURU, ap({ languages: declared }));
    expect(plan).not.toBeNull();
    if (plan?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(plan.desired).toEqual({ mode: 'no' });
    expect(plan.reviewReason).toMatch(/review before submitting/);
    // The filled No must never sail through the auto-submit countdown unreviewed.
    expect(skippedReasonsNeedReview([plan.reviewReason!])).toBe(true);
    // And the plan drives the actual ZURU radio pair to No.
    expect(matchOption(opts('Yes', 'No'), plan.desired)?.text).toBe('No');
  });

  it('ZURU with Spanish declared: a clean Yes, no review flag', () => {
    const plan = languageAnswerPlan(ZURU, ap({ languages: [...declared, 'Spanish'] }));
    if (plan?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(plan.desired).toEqual({ mode: 'yes' });
    expect(plan.reviewReason).toBeUndefined();
    expect(matchOption(opts('Yes', 'No'), plan.desired)?.text).toBe('Yes');
  });

  it('declared-language level question: the fluent tier, NEVER Native', () => {
    const plan = languageAnswerPlan('English level', ap({ languages: declared }));
    if (plan?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(plan.reviewReason).toBeUndefined();
    expect(matchOption(opts('Basic', 'Conversational', 'Fluent', 'Native'), plan.desired)?.text).toBe('Fluent');
    // CEFR-only selects: C1 (fluent-tier, the weaker of the two honest claims) over C2.
    expect(matchOption(opts('A1', 'A2', 'B1', 'B2', 'C1', 'C2'), plan.desired)?.text).toBe('C1');
    // LinkedIn-style tiers: Full professional, never Native or bilingual.
    expect(
      matchOption(
        opts('Elementary', 'Limited working', 'Professional working', 'Full professional proficiency', 'Native or bilingual'),
        plan.desired,
      )?.text,
    ).toBe('Full professional proficiency');
  });

  it('declared-language level question with ONLY Native-or-basic options: no match, adapter flags', () => {
    const plan = languageAnswerPlan('English level', ap({ languages: declared }));
    if (plan?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(matchOption(opts('Native', 'Basic'), plan.desired)).toBeNull();
    // The flag the adapters push on that null must hold the gate.
    expect(skippedReasonsNeedReview([languageSkipReason('English level', 'no honest option to select')])).toBe(true);
  });

  it('undeclared-language level question: the lowest HONEST option only, review-flagged', () => {
    const plan = languageAnswerPlan('Wie gut sind deine Deutschkenntnisse?', ap({ languages: declared }));
    if (plan?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(plan.reviewReason).toMatch(/review before submitting/);
    expect(skippedReasonsNeedReview([plan.reviewReason!])).toBe(true);
    // German options, eszett and all.
    expect(
      matchOption(opts('Keine Kenntnisse', 'Grundkenntnisse', 'Fließend', 'Muttersprache'), plan.desired)?.text,
    ).toBe('Keine Kenntnisse');
    // CEFR select: A1 is the sanctioned floor.
    expect(matchOption(opts('A1', 'B1', 'C1', 'Native'), plan.desired)?.text).toBe('A1');
    // No clearly-none/basic option -> null: the adapter leaves it and flags, never rounds up.
    expect(matchOption(opts('Beginner', 'Intermediate', 'Advanced'), plan.desired)).toBeNull();
  });

  it('EMPTY declared list: always-ask, never guess, and the reason holds auto-submit', () => {
    for (const profile of [ap(), ap({ languages: [] })]) {
      const plan = languageAnswerPlan(ZURU, profile);
      if (plan?.kind !== 'skip') throw new Error('expected a skip plan');
      expect(plan.reason).toMatch(/left for you/);
      expect(plan.reason).toMatch(/no languages declared/);
      expect(skippedReasonsNeedReview([plan.reason])).toBe(true);
    }
  });

  it('declared native names count: "Deutsch" answers a German question', () => {
    const plan = languageAnswerPlan('Are you fluent in German?', ap({ languages: ['Deutsch'] }));
    if (plan?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(plan.desired).toEqual({ mode: 'yes' });
    // Diacritics too: a declared "Español" answers a Spanish question.
    const plan2 = languageAnswerPlan('Do you speak Spanish?', ap({ languages: ['Español'] }));
    if (plan2?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(plan2.desired).toEqual({ mode: 'yes' });
  });

  it('a native-level yes/no ask is never answered from declared fluency', () => {
    const plan = languageAnswerPlan('Are you a native Arabic speaker?', ap({ languages: declared }));
    if (plan?.kind !== 'skip') throw new Error('expected a skip plan');
    expect(plan.reason).toMatch(/native-level/);
    expect(skippedReasonsNeedReview([plan.reason])).toBe(true);
  });

  it('Chinese family: declared Mandarin answers "Chinese" Yes; declared Chinese asked Mandarin is flagged', () => {
    const mandarin = languageAnswerPlan('Do you speak Chinese?', ap({ languages: ['Mandarin'] }));
    if (mandarin?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(mandarin.desired).toEqual({ mode: 'yes' });

    const chinese = languageAnswerPlan('Do you speak Mandarin?', ap({ languages: ['Chinese'] }));
    expect(chinese?.kind).toBe('skip');
  });

  it('multi-language stems: Yes only when EVERY named language is declared, flagged otherwise', () => {
    const both = languageAnswerPlan('Are you fluent in English and French?', ap({ languages: declared }));
    if (both?.kind !== 'fill') throw new Error('expected a fill plan');
    expect(both.desired).toEqual({ mode: 'yes' });

    // "and" vs "or" changes the honest answer when one is missing - flag, never guess a No.
    const mixed = languageAnswerPlan('Are you fluent in English and Spanish?', ap({ languages: declared }));
    expect(mixed?.kind).toBe('skip');
  });

  it('never plans anything for a refused label, whatever the declared list says', () => {
    expect(
      languageAnswerPlan(
        'Are you legally authorized to work in Spain and comfortable communicating in Spanish?',
        ap({ languages: [...declared, 'Spanish'] }),
      ),
    ).toBeNull();
  });
});
