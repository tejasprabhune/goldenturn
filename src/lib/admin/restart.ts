/**
 * Starting a submission over, whole or from one stage, and writing to the
 * person who submitted it.
 *
 * Both are offered wherever a failed or stuck round is listed (the overview,
 * the submissions table, one submission), so they live here rather than in
 * any one section.
 */

import * as api from './api';
import * as store from './store';
import { h, button, confirm } from './ui';

const SITE = 'https://goldenturn.org';

interface Option {
  from: api.RestartFrom | null;
  label: string;
  /** One sentence: what is redone, and what is kept. */
  says: string;
}

/** Only what makes sense for where the round is: no transcript before audio. */
export function restartOptions(s: api.AdminSubmission): Option[] {
  if (s.review === 'removed') return [];
  const m = s.progress.media;
  const out: Option[] = [
    { from: null, label: 'Restart everything',
      says: 'Every stage is redone from the start with the current link; the submission and its details are kept.' },
    { from: 'audio', label: 'Re-fetch audio',
      says: 'The audio is fetched again from the current link and every stage after it is redone; the details are kept.' },
  ];
  if (m.audio) {
    out.push({ from: 'transcript', label: 'Redo transcript',
      says: 'The transcript is made again from the stored audio and the speeches are relabelled after it; the audio is kept.' });
  }
  if (m.transcript) {
    out.push({ from: 'speeches', label: 'Redo speech labels',
      says: 'The speeches are labelled again from the stored transcript; the audio and the transcript are kept.' });
  }
  if (m.audio) {
    out.push({ from: 'page', label: 'Republish page',
      says: 'The round\'s page is built again; the audio, transcript and speech labels are kept.' });
  }
  return out;
}

/** Asks in one sentence, restarts, and says what the Worker actually did. */
function run(s: api.AdminSubmission, o: Option, after: () => void): Promise<void> {
  return confirm({
    title: `${o.label}?`,
    body: [`"${s.title}": ${o.says}`],
    action: o.label.split(' ')[0] === 'Restart' ? 'Restart' : o.label.split(' ')[0],
    run: async () => {
      const r = await api.retrySubmission(s.object_id, o.from ?? undefined);
      store.forget('submissions', 'rounds');
      // A Worker that does not yet take a stage restarts the whole round and
      // does not echo `from`; that is what happened, so that is what is said.
      if (o.from && r.from !== o.from) {
        return 'Queued, restarted from the beginning: the Worker does not take a stage yet. The next ingest run picks it up.';
      }
      return [
        `Queued${o.from ? ` from "${o.label.toLowerCase()}"` : ', from the beginning'}. The next ingest run picks it up.`,
        r.removed?.length ? `Deleted ${r.removed.join(', ')}.` : '',
        r.rebuilding ? 'The site is rebuilding.' : '',
      ].filter(Boolean).join(' ');
    },
  }).then(changed => { if (changed) after(); });
}

/** One click on a row: the whole round, still with its one-sentence check. */
export function restartButton(s: api.AdminSubmission, after: () => void): HTMLButtonElement | null {
  const [whole] = restartOptions(s);
  if (!whole) return null;
  const b = button('Restart', e => { e.stopPropagation(); void run(s, whole, after); });
  b.classList.add('adm-button-small');
  b.title = whole.says;
  return b;
}

/** The detail page's control: a small menu of what can be redone. */
export function restartMenu(s: api.AdminSubmission, after: () => void, primary = false): HTMLElement {
  const options = restartOptions(s);
  const menu = h('details.adm-menu', null,
    h(`summary.adm-button${primary ? '.primary' : ''}` as 'summary', null, 'Restart'),
    h('div.adm-menu-list', { role: 'menu' }, options.map(o => h('button.adm-menu-item', {
      type: 'button', role: 'menuitem', title: o.says,
      onclick: () => { menu.open = false; void run(s, o, after); },
    }, o.label))),
  );
  if (!options.length) {
    menu.classList.add('is-disabled');
    menu.title = 'A removed round has to be submitted again';
  }
  return menu;
}

/**
 * Whether the failure is one only the submitter can mend: a dead, private or
 * wrong link, or a file that is not a recording. A host refusing the runner,
 * a timeout or an unknown error is the admin's to retry first.
 */
export function submitterMustFix(s: api.AdminSubmission): boolean {
  const note = s.note ?? '';
  return /only \d+s of audio|download 4(0[0-9]|1[0-9])|private video|video unavailable|has been removed|is not available|members-only|no longer available|unsupported url|produced no file|is not a valid url|invalid data found|moov atom|does not contain any stream|could not find codec/i.test(note);
}

/** A mailto link that says what went wrong and how to send it again. */
export function emailSubmitter(s: api.AdminSubmission, secondary = false): HTMLElement | null {
  if (!s.author_email) return null;
  const reason = s.progress.failure?.reason ?? 'The recording could not be fetched from the link.';
  const resubmit = `${SITE}/recordings/add/?resubmit=${encodeURIComponent(s.object_id)}`;
  const subject = `Your goldenturn submission: ${s.title}`;
  const body = [
    `Hello${s.author ? ` ${s.author}` : ''},`,
    '',
    `Your submission "${s.title}" could not be processed. ${reason}`,
    '',
    `You can send it again with a corrected link here, with everything else filled in: ${resubmit}`,
    '',
    'Thank you for submitting it.',
  ].join('\n');
  const href = `mailto:${s.author_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return h('span.adm-inline.adm-contact', null,
    h(`a.adm-button${secondary ? '' : '.primary'}` as 'a', { href }, 'Email the submitter'),
    h('span.adm-email', { title: 'The submitter\'s address' }, s.author_email));
}

// An open menu closes on a click anywhere else, or on Escape.
document.addEventListener('click', e => {
  for (const m of document.querySelectorAll<HTMLDetailsElement>('details.adm-menu[open]')) {
    if (!m.contains(e.target as Node)) m.open = false;
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const m of document.querySelectorAll<HTMLDetailsElement>('details.adm-menu[open]')) m.open = false;
});
