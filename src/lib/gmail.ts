export function buildGmailComposeLink(
  to: string,
  subject: string,
  body: string,
): string {
  const base = 'https://mail.google.com/mail/?view=cm&fs=1';
  return (
    `${base}` +
    `&to=${encodeURIComponent(to)}` +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  );
}
