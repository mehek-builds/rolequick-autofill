import { describe, it, expect } from 'vitest';
import { isOpenEndedQuestion, fitToBudget } from './generic';

// R-033's pure halves: which labels count as prose questions, and how a drafted answer meets a
// character budget. Both err toward "leave it for the student": a false negative here is a
// flagged blank (recoverable), a false positive is an essay typed into a name field (not).

describe('isOpenEndedQuestion', () => {
  it('matches the live Gemini label that shipped the bug', () => {
    expect(
      isOpenEndedQuestion(
        'please share 3-5 sentences explaining your interest in the blockchain/web3 industry.*',
      ),
    ).toBe(true);
  });

  it('matches the common essay phrasings', () => {
    expect(isOpenEndedQuestion('why do you want to work here?')).toBe(true);
    expect(isOpenEndedQuestion('describe a project you are proud of')).toBe(true);
    expect(isOpenEndedQuestion('tell us about a time you disagreed with a teammate')).toBe(true);
    expect(isOpenEndedQuestion('what makes you a good fit for this role?')).toBe(true);
    expect(isOpenEndedQuestion('how did you first get into software engineering?')).toBe(true);
  });

  it('matches a long interrogative even without the verb list', () => {
    expect(isOpenEndedQuestion('what would your ideal first ninety days at this company look like?')).toBe(true);
  });

  it('does NOT match plain field labels, even required ones', () => {
    // These are exactly the fields that must never become essays.
    expect(isOpenEndedQuestion('preferred first name')).toBe(false);
    expect(isOpenEndedQuestion('first name *')).toBe(false);
    expect(isOpenEndedQuestion('email')).toBe(false);
    expect(isOpenEndedQuestion('linkedin profile')).toBe(false);
    expect(isOpenEndedQuestion('current company')).toBe(false);
  });

  it('does NOT match a short interrogative field name', () => {
    expect(isOpenEndedQuestion('preferred name?')).toBe(false);
  });

  it('handles empty and whitespace labels', () => {
    expect(isOpenEndedQuestion('')).toBe(false);
    expect(isOpenEndedQuestion('   ')).toBe(false);
  });
});

describe('fitToBudget', () => {
  it('returns the text unchanged when it fits', () => {
    expect(fitToBudget('Two short sentences. They fit fine.', 255)).toBe(
      'Two short sentences. They fit fine.',
    );
  });

  it('trims to the last whole sentence inside the budget, never mid-word', () => {
    const text =
      'I built Tonee, an AI texting tone detector, and shipped it to a hundred users. ' +
      'Along the way I rebuilt the labelling pipeline twice and cut latency from seconds to milliseconds for every request we served.';
    const fitted = fitToBudget(text, 120);
    expect(fitted).toBe('I built Tonee, an AI texting tone detector, and shipped it to a hundred users.');
    expect(fitted!.length).toBeLessThanOrEqual(120);
  });

  it('does not cut at a decimal point inside a number', () => {
    const text =
      'I raised my model accuracy to 89.5 percent over one semester of active learning work on the dataset, and I wrote up the method. Then more.';
    const fitted = fitToBudget(text, 130);
    // The "." in 89.5 is followed by a digit, so it is not a sentence end; the cut lands on the
    // real terminator instead.
    expect(fitted).toBe(
      'I raised my model accuracy to 89.5 percent over one semester of active learning work on the dataset, and I wrote up the method.',
    );
  });

  it('surrenders (null) when no real sentence fits, instead of shipping a fragment', () => {
    // A fragment that ends mid-clause misrepresents the student (the R-029 family), so a blank
    // flagged for review beats it.
    expect(fitToBudget('This opening clause runs far longer than the tiny budget allows', 30)).toBeNull();
  });

  it('treats an empty draft as no draft', () => {
    expect(fitToBudget('', 255)).toBeNull();
    expect(fitToBudget('   ', 255)).toBeNull();
  });
});

describe('isOpenEndedQuestion: live Cresta phrasing (2026-07-17)', () => {
  it('recognises the exact Cresta SWE Intern label that shipped undrafted', () => {
    // Verbatim from job-boards.greenhouse.io/cresta/jobs/4123841008, where the gate refused to
    // draft: no listed verb, no question mark. "brief note" and "you most enjoy" are the signals.
    expect(
      isOpenEndedQuestion(
        'To help us find the best team match, please include a brief note on the type of problems you most enjoy working on. For example: *',
      ),
    ).toBe(true);
  });

  it('does not turn short field labels into essays', () => {
    // The widened vocabulary must not make a plain note/enjoyment field an essay invitation on
    // its own; these stay closed because they are field names, not prose asks.
    expect(isOpenEndedQuestion('Note')).toBe(false);
    expect(isOpenEndedQuestion('Notes')).toBe(false);
    expect(isOpenEndedQuestion('Additional note')).toBe(false);
  });
});
