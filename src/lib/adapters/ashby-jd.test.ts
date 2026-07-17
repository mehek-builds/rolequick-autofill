import { describe, it, expect } from 'vitest';
import { looksLikeJobDescription, htmlToPlainText, MIN_JD_CHARS } from './shared/jd';
import { parseAshbyPostingRef, selectPostingJd, extractDescriptionHtmlFromSource } from './ashby';

// R-013. The measurements quoted here are from live boards on 2026-07-17.

const realJd = (n = 600) => `We are hiring an engineer to work on agents in production. ${'Responsibilities include shipping. '.repeat(n / 34)}`;

describe('looksLikeJobDescription', () => {
  it('accepts a real posting', () => {
    expect(looksLikeJobDescription(realJd())).toBe(true);
  });

  it('rejects Enpal\'s 5-char header, which BECAME the entire JD', () => {
    // The old selector's first match was `ashby-job-posting-header`, whose text was "Enpal".
    // Truthy, so it was returned as the whole job description and tailored against.
    expect(looksLikeJobDescription('Enpal')).toBe(false);
  });

  it('rejects the Application tab body, which passed for a JD on Cohere and Mistral', () => {
    // ~1,261 chars of title + location + employment type + form chrome. It cleared the backend's
    // 18% coverage bar only because the job TITLE carries the keywords, so the resume shipped
    // "tailored" to a title and some form labels. This is the register's own suggested regression
    // test: > ~400 chars AND does not contain "Autofill from resume".
    const applicationTabBody = `Machine Learning Intern San Francisco, California Full time Intern
      Autofill from resume Upload File drag and drop your resume here
      Full name Email Phone Resume LinkedIn ${'Submit application '.repeat(60)}`;
    expect(applicationTabBody.length).toBeGreaterThan(MIN_JD_CHARS); // long enough to fool a length check
    expect(looksLikeJobDescription(applicationTabBody)).toBe(false); // ...and still not a JD
  });

  it('rejects empty and short text', () => {
    expect(looksLikeJobDescription('')).toBe(false);
    expect(looksLikeJobDescription(null)).toBe(false);
    expect(looksLikeJobDescription(undefined)).toBe(false);
    expect(looksLikeJobDescription('Software Engineer Intern')).toBe(false);
  });
});

describe('parseAshbyPostingRef', () => {
  it('reads the org and posting id off a posting URL', () => {
    expect(parseAshbyPostingRef('https://jobs.ashbyhq.com/espa/6fa2d441-971f-44c4-9a4e-3304ea041cc8'))
      .toEqual({ org: 'espa', postingId: '6fa2d441-971f-44c4-9a4e-3304ea041cc8' });
  });

  it('reads them off the /application route too, which is where the card actually lives', () => {
    expect(parseAshbyPostingRef('https://jobs.ashbyhq.com/cohere/6fa2d441-971f-44c4-9a4e-3304ea041cc8/application'))
      .toEqual({ org: 'cohere', postingId: '6fa2d441-971f-44c4-9a4e-3304ea041cc8' });
  });

  it('returns null off-board or with no posting id', () => {
    expect(parseAshbyPostingRef('https://jobs.ashbyhq.com/espa')).toBeNull();
    expect(parseAshbyPostingRef('https://boards.greenhouse.io/acme/jobs/123')).toBeNull();
    expect(parseAshbyPostingRef('not a url')).toBeNull();
  });
});

describe('selectPostingJd', () => {
  const payload = {
    jobs: [
      { id: 'aaaaaaaa-0000-0000-0000-000000000000', descriptionPlain: 'wrong job', jobUrl: 'https://jobs.ashbyhq.com/x/aaaaaaaa-0000-0000-0000-000000000000' },
      { id: 'bbbbbbbb-1111-1111-1111-111111111111', descriptionPlain: 'the right job description', jobUrl: 'https://jobs.ashbyhq.com/x/bbbbbbbb-1111-1111-1111-111111111111' },
    ],
  };

  it('matches on the posting id from the page URL, not the title', () => {
    // A board running two postings with the same title is why this matches on id.
    expect(selectPostingJd(payload, 'bbbbbbbb-1111-1111-1111-111111111111')).toBe('the right job description');
  });

  it('falls back to the jobUrl when the id field is absent', () => {
    const noIds = { jobs: [{ jobUrl: 'https://jobs.ashbyhq.com/x/cccccccc-2222-2222-2222-222222222222', descriptionPlain: 'found via url' }] };
    expect(selectPostingJd(noIds, 'cccccccc-2222-2222-2222-222222222222')).toBe('found via url');
  });

  it('returns null when the posting is not on the board, rather than picking one', () => {
    expect(selectPostingJd(payload, 'dddddddd-3333-3333-3333-333333333333')).toBeNull();
  });

  it('survives a payload that is not the shape we expect', () => {
    expect(selectPostingJd(null, 'x')).toBeNull();
    expect(selectPostingJd({}, 'x')).toBeNull();
    expect(selectPostingJd({ jobs: 'nope' }, 'x')).toBeNull();
    expect(selectPostingJd({ jobs: [{ id: 'x', descriptionPlain: '' }] }, 'x')).toBeNull();
  });
});

describe('extractDescriptionHtmlFromSource', () => {
  // The fallback that matters: Ashby's posting API does NOT resolve for every board (slugs that
  // 404 were measured live), but every posting page - including /application - embeds this.
  it('pulls the description out of the page bootstrap payload', () => {
    const source = `<script>window.__appData = {"foo":1,"descriptionHtml":"<h2>Engineer</h2><p>Build <strong>agents</strong> &amp; ship them.</p>","bar":2};</script>`;
    expect(extractDescriptionHtmlFromSource(source)).toBe('Engineer\nBuild agents & ship them.');
  });

  it('handles escaped quotes inside the description', () => {
    const source = String.raw`window.__appData = {"descriptionHtml":"<p>We say \"hello\" here</p>"};`;
    expect(extractDescriptionHtmlFromSource(source)).toBe('We say "hello" here');
  });

  it('returns null when the payload is absent', () => {
    expect(extractDescriptionHtmlFromSource('<html><body>nothing here</body></html>')).toBeNull();
    expect(extractDescriptionHtmlFromSource('')).toBeNull();
  });
});

describe('htmlToPlainText', () => {
  it('drops markup and decodes entities', () => {
    expect(htmlToPlainText('<p>Hello &amp; welcome</p><p>Second</p>')).toBe('Hello & welcome\nSecond');
  });

  it('drops script and style content, which would otherwise land in the JD', () => {
    expect(htmlToPlainText('<p>Real text</p><script>var x = "junk";</script><style>.a{color:red}</style>')).toBe('Real text');
  });

  it('decodes numeric entities', () => {
    expect(htmlToPlainText('<p>10&#8211;14 weeks</p>')).toBe('10–14 weeks');
  });
});
