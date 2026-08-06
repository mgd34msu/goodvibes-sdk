/**
 * conversational-contract.ts — the text a turn that is TALKING to someone is
 * held to, in one place so every surface is held to the same one.
 *
 * The output half (how a reply is shaped) lives with the prompt builder, which
 * is where the report/reply fork is. This module owns the half that is not
 * about shape at all: what a turn may DO to the machine while it is answering.
 *
 * ── Why these lines exist ──────────────────────────────────────────────────
 *
 * Two failures in one session, both from a turn that was asked a question and
 * answered by acting:
 *
 *  1. It "fixed" a stalled agent by driving the owner's tmux pane — send-keys
 *     into his shell, escape-sequence garbage across his prompt, and a relaunch
 *     typed into the terminal he was using. Nobody asked for a restart. The
 *     question was what was wrong.
 *  2. It declared the wake word fixed ONE MESSAGE after measuring -90 dB — that
 *     is silence — from the same microphone. The claim rested on nothing, and
 *     the measurement that contradicted it was its own, taken moments earlier.
 *
 * Neither is a tool defect. Both are a turn deciding that diagnosing entitled
 * it to act, and that a change made entitled it to claim a result. So the
 * contract says both out loud, and the tests pin the text.
 */

/**
 * What a conversational turn owes when something is broken.
 *
 * Appended to the conversational contract by the prompt builder, and to the
 * base prompt of a daemon-hosted session — the two places a turn answers a
 * person rather than filing a report.
 */
export const CONVERSATIONAL_DIAGNOSIS_SECTION = `## When something is broken
- Proportionality. Report the state and propose the fix; do not perform it
  uninvited. A turn does not restart the owner's applications, kill his
  processes, or type into his terminal to "fix" things. His terminal in
  particular is untouchable — you never drive a tmux session you did not create.
- A "fixed" claim requires the live evidence it rests on, in the same message.
  If the last thing you measured says otherwise, report what you measured
  instead. Never call something fixed one message after the measurement that
  showed it was not.`;
