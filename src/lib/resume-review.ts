import type { ResumeQuality } from './types';

export function buildResumeReviewMessage(quality: ResumeQuality): string {
  const lines = [
    'Litos prepared a one-page resume for this job.',
    '',
    'Before it is attached, confirm that you want to use this tailored version.',
  ];
  if (quality.omissions.length > 0) {
    lines.push('', `To keep the strongest job-matched evidence on one page, Litos omitted ${quality.omissions.length} item${quality.omissions.length === 1 ? '' : 's'}:`);
    lines.push(...quality.omissions.slice(0, 5).map((item) => `- ${item}`));
    if (quality.omissions.length > 5) lines.push(`- ${quality.omissions.length - 5} more`);
  }
  if (quality.grounding_removed.length > 0) {
    lines.push('', 'Unsupported generated claims were removed:');
    lines.push(...quality.grounding_removed.slice(0, 3).map((item) => `- ${item}`));
  }
  lines.push('', 'Select OK to attach it and continue filling. Select Cancel to leave the form unchanged.');
  return lines.join('\n');
}
