// Throwaway mock backend for the visual preview only. Serves canned JSON on :3001
// so the screens that fetch on mount (MainScreen, DraftEditor, Tracking) populate.
import { createServer } from 'node:http';

const events = [
  {
    id: 'e1',
    contact: { id: 'c1', full_name: 'Priya Sharma', title: 'Eng Recruiter', persona: 'recruiter', company_domain: 'stripe.com', school_match: false, tier: 'green', status: 'verified' },
    channel: 'email', subject: 'USC student, quick question about the SWE intern role', sent_at: '2026-06-05T10:00:00Z', bounced: false, status: 'replied',
  },
  {
    id: 'e2',
    contact: { id: 'c2', full_name: 'Marcus Lee', title: 'Software Engineer', persona: 'alumni', company_domain: 'figma.com', school_match: true, tier: 'green', status: 'verified' },
    channel: 'email', subject: 'Fellow Trojan reaching out', sent_at: '2026-06-06T10:00:00Z', bounced: false, status: 'sent',
  },
  {
    id: 'e3',
    contact: { id: 'c3', full_name: 'Dana Whitfield', title: 'Hiring Manager, Growth', persona: 'hiring_manager', company_domain: 'notion.so', school_match: false, tier: 'amber', status: 'likely' },
    channel: 'email', subject: 'Interested in the New Grad PM role', sent_at: '2026-06-07T10:00:00Z', bounced: false, status: 'drafted',
  },
];

const draft = {
  subject: "Fellow Trojan reaching out about the SWE intern role",
  body: "Hi Marcus,\n\nI'm a junior at USC studying CS, and I came across the software engineer intern opening on your team at Figma. I noticed you made the same jump from USC into engineering, so your path really stood out to me.\n\nI've spent the last year building full-stack side projects (most recently a React + FastAPI study tool that hit 400 users on campus), and I'd love to bring that energy to Figma. Would you be open to a quick 15-minute chat about what the team looks for?\n\nThank you for your time,\nAlex",
  word_count: 92,
  warnings: [],
};

const send = (res, code, data) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  });
  res.end(JSON.stringify(data));
};

createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = req.url || '';
  if (url.startsWith('/track/events')) return send(res, 200, events);
  if (url.startsWith('/draft')) return send(res, 200, draft);
  if (url.startsWith('/track/event')) return send(res, 200, {});
  return send(res, 200, {});
}).listen(3001, () => console.log('mock backend on :3001'));
