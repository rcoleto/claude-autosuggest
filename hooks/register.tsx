import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptDecoration, Register } from 'claude-code'

import type { BandSuggestion } from '../types'

/**
 * Where Claude Code has no prompt box of its own to put ghost text in (the
 * desktop app draws its own box), the next-prompt suggestion goes in a band
 * above the prompt instead, with a button to send it.
 */
const band = atom({ plugin: 'autosuggest', key: 'band' } as const, null as BandSuggestion)

// ---------------------------------------------------------------------------
// Settings (kept in $.store, so they survive restarts)
// ---------------------------------------------------------------------------

/** Master switch: false turns every suggestion off. */
const ENABLED_KEY = 'enabled'
/** Next-prompt suggestion in the empty box after Claude answers. */
const NEXT_KEY = 'next'
/** Inline completion of a half-written draft after a pause. */
const INLINE_KEY = 'inline'
/** How long the draft must sit still before an inline completion is asked for. */
const DELAY_KEY = 'delayMs'

const DEFAULT_DELAY_MS = 2000
const MIN_DELAY_MS = 500
const MAX_DELAY_MS = 10000

const MAX_NEXT_CHARS = 220
const MAX_INLINE_CHARS = 140
/** Drafts shorter than this are too thin to guess from. */
const MIN_DRAFT_CHARS = 6

// ---------------------------------------------------------------------------
// Prompts sent to the model through $.model.fork
// ---------------------------------------------------------------------------

// Both ask for haste in the prompt instead of passing `effort`: a fork that
// names no effort reuses the main thread's prompt cache on every model.

/**
 * How the user writes, read from their own earlier messages above: the model
 * copies it so a suggestion reads like something they would have typed.
 */
const STYLE = `Copy the USER's own writing style from their earlier messages in this
conversation: their language (if they write in Portuguese, write in Portuguese),
their usual length, casing, punctuation and how formal they are. If they write
short lowercase messages without a final period, do the same.`

const ASK_NEXT = `[autosuggest] You have no tools for this message. Do not continue the
work and do not answer as the assistant. Be quick.
Predict the single next message the USER is most likely to send you now.
Work it out in this order and use the first that applies:
1. Your last reply asked the user a question or offered options: write the
   answer they would most likely give (e.g. approving the option you
   recommended, or choosing between the options).
2. Your last reply said something failed, is unverified, or needs the user to
   check something: write what they would most likely do or ask about it.
3. Your last reply proposed a next step: write the user asking for it.
4. Otherwise: the natural next task in what they are building.
${STYLE}
Be concrete: name the files, commands, options or findings from this
conversation. Never suggest something already done, never a bare "ok" or
"thanks", never repeat the user's previous message.
Reply in exactly two lines:
WHY: <at most 12 words on which rule applied>
SUGGESTION: <the message, at most 25 words>
If no suggestion would really help, reply with exactly: SUGGESTION: NONE`

function askInline(draft: string): string {
  return `[autosuggest] You have no tools for this message. Do not answer the draft
and do not continue the work. Answer straight away, without thinking it over.
The USER is in the middle of typing their next message to you. Their unfinished
draft is between the markers below, exactly as typed:
<<<DRAFT
${draft}
DRAFT>>>
Reply with ONLY the text that should come right after the draft's last
character to finish their thought, at most 15 words, ending at a natural
stopping point. Use what this conversation is about: prefer the real names of
files, functions, commands and options mentioned above over generic words.
${STYLE}
Start with a space if the next word is a new word; start without one if the
draft stops in the middle of a word. Never repeat the draft. No quotes, no
labels, no explanation.
If you can't tell how they'd continue, reply with exactly: NONE`
}

// ---------------------------------------------------------------------------
// Cleaning model output
// ---------------------------------------------------------------------------

const LABEL = /^(user|you|me|next( prompt| message)?|suggestion|prompt|continuation)\s*:\s*/i
const WRAP = /^[\s"'`“”*_]+|[\s"'`“”*_]+$/g
const QUOTES = /^["'`“”]+|["'`“”]+$/g

/** Replies too generic to be worth a suggestion. */
const GENERIC = /^(ok(ay)?|ok,? (obrigad[oa]|valeu|thanks)|obrigad[oa]|valeu|thanks|thank you|perfeito|perfect|great|nice|show|beleza|legal)[\s.!]*$/i

const normalize = (s: string) => s.toLowerCase().replace(/[\s.!?,;:]+/g, ' ').trim()

/**
 * Picks the suggestion out of the model's reply (the `SUGGESTION:` line when
 * there is one, else the first line), cleans it, and drops what isn't worth
 * showing: NONE, a bare "ok"/"thanks", or a repeat of `previous`.
 */
export function clean(raw: string, previous?: string): string | undefined {
  const lines = raw.split('\n').map(line => line.trim()).filter(line => line !== '')
  const tagged = lines.find(line => /^\**suggestion\**\s*:/i.test(line.replace(WRAP, '')))
  let text = tagged ?? lines.find(line => !/^\**why\**\s*:/i.test(line.replace(WRAP, ''))) ?? ''
  text = text.replace(WRAP, '').trim().replace(LABEL, '').replace(WRAP, '').trim()
  if (text === '' || /^none\.?$/i.test(text)) return undefined
  if (GENERIC.test(text)) return undefined
  if (previous !== undefined && normalize(previous) === normalize(text)) return undefined
  return text.length > MAX_NEXT_CHARS ? `${text.slice(0, MAX_NEXT_CHARS - 1)}…` : text
}

/**
 * Turns the model's reply into the text drawn after the draft, keeping the
 * leading space the model chose (it decides between finishing a word and
 * starting a new one). Returns undefined when there is nothing worth showing.
 */
export function cleanContinuation(raw: string, draft: string): string | undefined {
  const firstLine = raw.split('\n').find(line => line.trim() !== '') ?? ''
  const lead = /^\s/.test(firstLine) ? ' ' : ''
  let text = firstLine.trim().replace(LABEL, '').replace(QUOTES, '').trimEnd()
  if (text === '' || /^none\.?$/i.test(text)) return undefined

  // A model that echoed the draft: keep only what comes after it.
  const tail = draft.trimEnd()
  if (tail !== '' && text.startsWith(tail)) text = text.slice(tail.length)
  else if (lead === '' && /\s$/.test(draft)) text = text.trimStart()

  let out = lead + text
  // The draft already ends in whitespace: don't add a second space.
  if (/\s$/.test(draft)) out = out.trimStart()
  if (out.trim() === '') return undefined
  if (out.length > MAX_INLINE_CHARS) {
    const cut = out.slice(0, MAX_INLINE_CHARS)
    const lastSpace = cut.lastIndexOf(' ')
    out = lastSpace > 0 ? cut.slice(0, lastSpace) : cut
  }
  return out
}

/**
 * Whether a draft is worth completing: long enough, caret at the end, not a
 * finished sentence (ends with "."), not a slash command or a shell line.
 */
export function whyNotComplete(text: string, cursor: number): string | undefined {
  if (cursor !== text.length) return 'cursor is not at the end'
  const trimmed = text.trim()
  if (trimmed.length < MIN_DRAFT_CHARS) return `draft shorter than ${MIN_DRAFT_CHARS} characters`
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) return 'slash command or shell line'
  if (text.trimEnd().endsWith('.')) return 'draft ends with a period'
  return undefined
}

export function shouldComplete(text: string, cursor: number): boolean {
  return whyNotComplete(text, cursor) === undefined
}

export function ghostDecoration(at: number, ghost: string): PromptDecoration {
  // dimColor is the terminal's faint style: the same look as disabled text.
  return { start: at, end: at, virtualText: ghost, dimColor: true }
}

// ---------------------------------------------------------------------------
// Settings helpers (top-level so $ may be passed to them)
// ---------------------------------------------------------------------------

async function isOn($: EngineInterface, key: string): Promise<boolean> {
  if ((await $.store.get(ENABLED_KEY)) === false) return false
  return (await $.store.get(key)) !== false
}

async function delayMs($: EngineInterface): Promise<number> {
  const stored = await $.store.get(DELAY_KEY)
  return typeof stored === 'number' ? stored : DEFAULT_DELAY_MS
}

async function statusText($: EngineInterface): Promise<string> {
  const all = (await $.store.get(ENABLED_KEY)) !== false
  const next = (await $.store.get(NEXT_KEY)) !== false
  const inline = (await $.store.get(INLINE_KEY)) !== false
  const seconds = (await delayMs($)) / 1000
  if (!all) return 'Autosuggest is off. Turn it back on with /autosuggest on.'
  return [
    'Autosuggest is on.',
    `  Next-prompt suggestions: ${next ? 'on' : 'off'}`,
    `  Inline completion: ${inline ? 'on' : 'off'} (after ${seconds}s without typing)`,
  ].join('\n')
}

const USAGE = `Usage:
  /autosuggest                 show what's on
  /autosuggest debug           what happened on the last inline completion attempts
  /autosuggest on | off        turn everything on or off
  /autosuggest next on | off   next-prompt suggestion after each reply
  /autosuggest inline on | off completion of what you're typing
  /autosuggest delay <seconds> pause before an inline completion (0.5 to 10)`

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

type Ghost = { draft: string; text: string }

/** What the inline completion keeps between keystrokes. */
type InlineState = {
  /** Changes on every edit, so a completion for an older draft is dropped. */
  draftVersion: number
  ghost: Ghost | undefined
  isForking: boolean
  /** The last steps of inline completion, for /autosuggest debug. */
  log: string[]
}

const LOG_LINES = 30

/** Shortens a draft for the debug log: its last 40 characters, quoted. */
const tail = (text: string) => JSON.stringify(text.length > 40 ? `…${text.slice(-40)}` : text)

function note(st: InlineState, line: string) {
  const time = new Date().toISOString().slice(11, 23)
  st.log.push(`${time}  ${line}`)
  if (st.log.length > LOG_LINES) st.log.splice(0, st.log.length - LOG_LINES)
}

async function requestInline($: EngineInterface, st: InlineState, draft: string, version: number) {
  if (st.isForking) {
    note(st, 'skipped: another completion is still being generated')
    return
  }
  st.isForking = true
  try {
    note(st, `asking the model to continue ${tail(draft)}`)
    const reply = await $.model.fork({ prompt: askInline(draft) })
    if (!reply.isAnswered) {
      note(st, `model gave no text: ${reply.reason}`)
      return
    }
    note(st, `model replied ${JSON.stringify(reply.text.slice(0, 120))}`)
    if (version !== st.draftVersion) {
      note(st, 'dropped: the draft changed while the model was answering')
      return
    }
    const text = cleanContinuation(reply.text, draft)
    if (text === undefined) {
      note(st, 'dropped: nothing left after cleaning (NONE, blank or only the draft)')
      return
    }
    // Read the box first: a plugin that reads it is handed the real draft, and
    // it also proves the draft is still the one the completion was made for.
    const box = await $.prompt.read()
    if (box.text !== draft || box.cursor !== draft.length) {
      note(st, `dropped: the box now reads ${tail(box.text)} (cursor ${box.cursor})`)
      return
    }
    const painted = await $.prompt.paint({
      text: draft,
      decorations: [ghostDecoration(draft.length, text)],
    })
    note(st, painted.isPainted
      ? `painted ${JSON.stringify(text)} after the draft`
      : `not painted: Claude Code refused (box reads ${tail(painted.text)})`)
    if (painted.isPainted && version === st.draftVersion) st.ghost = { draft, text }
  } catch (err) {
    note(st, `error: ${String(err)}`)
    $.ui.log(`autosuggest: ${String(err)}`, { to: 'debug' })
  } finally {
    st.isForking = false
  }
}

export const register: Register = on => {
  // Bumped on every prompt sent, so a next-prompt suggestion made for an older
  // turn is dropped.
  let generation = 0
  // A terminal session: Claude Code draws the prompt box itself.
  let isInteractive = true
  // Guards against a fork's own completion re-entering turn.complete.
  let isForkingNext = false
  // The user's last message, so the suggestion never just repeats it.
  let lastPrompt: string | undefined

  const st: InlineState = { draftVersion: 0, ghost: undefined, isForking: false, log: [] }
  let idleTimer: { cancel: () => void } | undefined

  const stopIdle = () => {
    idleTimer?.cancel()
    idleTimer = undefined
  }

  const forget = () => {
    stopIdle()
    st.ghost = undefined
    st.draftVersion += 1
  }

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.command.register({
      name: 'autosuggest',
      description:
        'Ghost-text suggestions: next prompt after replies, inline completion while you type. Try /autosuggest help',
    })
    return next(e)
  })

  // ---- /autosuggest ------------------------------------------------------

  on('command.run', { command: 'autosuggest' }, async ($, e) => {
    const words = (e.args ?? '').trim().toLowerCase().split(/\s+/).filter(w => w !== '')
    const [first, second] = words

    if (first === undefined || first === 'status') return { text: await statusText($) }
    if (first === 'help') return { text: USAGE }
    if (first === 'debug') {
      const surfaces = await $.session.surfaces()
      return {
        text: [
          await statusText($),
          `Terminal prompt box: ${isInteractive ? 'yes' : 'no'}; surfaces: ${surfaces.join(', ') || 'none'}`,
          '',
          'Last inline completion steps (oldest first):',
          ...(st.log.length > 0 ? st.log : ['  (nothing yet: no edit has reached the plugin)']),
        ].join('\n'),
      }
    }

    if ((first === 'on' || first === 'off') && second === undefined) {
      await $.store.set(ENABLED_KEY, first === 'on')
      if (first === 'off') {
        forget()
        await update($, band, () => null)
      }
      return { text: `Autosuggest ${first}.` }
    }

    if ((first === 'next' || first === 'inline') && (second === 'on' || second === 'off')) {
      await $.store.set(first === 'next' ? NEXT_KEY : INLINE_KEY, second === 'on')
      if (second === 'on') await $.store.set(ENABLED_KEY, true)
      if (first === 'inline' && second === 'off') forget()
      if (first === 'next' && second === 'off') await update($, band, () => null)
      const what = first === 'next' ? 'Next-prompt suggestions' : 'Inline completion'
      return { text: `${what} ${second}.` }
    }

    if (first === 'delay' && second !== undefined) {
      const seconds = Number(second.replace(',', '.').replace(/s$/, ''))
      if (!Number.isFinite(seconds)) return { text: `"${second}" isn't a number of seconds.\n${USAGE}` }
      const ms = Math.round(Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, seconds * 1000)))
      await $.store.set(DELAY_KEY, ms)
      return { text: `Inline completion now waits ${ms / 1000}s after you stop typing.` }
    }

    return { text: `Unknown option "${words.join(' ')}".\n${USAGE}` }
  })

  // ---- Next-prompt suggestion (empty box, after a reply) -----------------

  on('prompt.submit', async ($, e, next) => {
    await update($, band, () => null)
    lastPrompt = e.text
    generation += 1
    forget()
    return next(e)
  })

  // While on, this plugin owns the empty-box ghost text: hide the engine's
  // built-in guess so the two don't race for the same slot.
  on('prompt.suggest', async ($, e, next) => {
    if (e.origin.kind === 'suggestion' && (await isOn($, NEXT_KEY))) {
      return { isShown: false }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Main loop only, only after a real answer, only where a box can show it.
    if (e.agentId !== undefined || e.reason !== 'answer') return result
    if (isForkingNext || !(await isOn($, NEXT_KEY))) return result
    // Nobody to show it to (claude -p, an SDK run with no app attached): skip
    // the paid request. The terminal, or an app such as the desktop one, counts.
    if (!isInteractive && (await $.session.surfaces()).length === 0) return result

    const mine = ++generation
    // Fire and forget: the box only shows a suggestion once the turn is over.
    void (async () => {
      isForkingNext = true
      try {
        const reply = await $.model.fork({ prompt: ASK_NEXT })
        if (mine !== generation || !reply.isAnswered) return
        const text = clean(reply.text, lastPrompt)
        if (text === undefined) return
        const shown = await $.prompt.suggest({ text })
        // No ghost text possible here (an app draws the prompt box): use the band.
        if (!shown.isShown && mine === generation) await update($, band, () => text)
      } catch (err) {
        $.ui.log(`autosuggest: ${String(err)}`, { to: 'debug' })
      } finally {
        isForkingNext = false
      }
    })()
    return result
  })

  // ---- Inline completion (half-written draft, after a pause) -------------

  on('prompt.edit', async ($, e, next) => {
    const atEnd = e.cursor === e.text.length
    const plain = e.key !== undefined && !e.key.ctrl && !e.key.meta && !e.key.shift

    // Tab (or → at the end of the draft) takes the shown completion.
    if (st.ghost !== undefined && st.ghost.draft === e.text && atEnd && plain &&
        (e.key?.key === 'tab' || e.key?.key === 'right')) {
      const text = e.text + st.ghost.text
      note(st, `accepted with ${e.key?.key}`)
      forget()
      return { text, cursor: text.length }
    }

    const shown = st.ghost
    const r = await next(e)
    stopIdle()
    st.draftVersion += 1
    st.ghost = undefined

    // Typing the very characters the completion shows keeps the rest on screen.
    if (shown !== undefined && r.cursor === r.text.length &&
        r.text.startsWith(shown.draft) && r.text.length > shown.draft.length) {
      const typed = r.text.slice(shown.draft.length)
      if (shown.text.startsWith(typed) && shown.text.length > typed.length) {
        const rest = shown.text.slice(typed.length)
        st.ghost = { draft: r.text, text: rest }
        return { ...r, decorations: [...(r.decorations ?? []), ghostDecoration(r.text.length, rest)] }
      }
    }

    const keyName = e.key?.key ?? (e.inputText.length > 1 ? 'paste/burst' : 'no key')
    note(st, `edit (${keyName}): box ${tail(r.text)}, cursor ${r.cursor}/${r.text.length}`)
    if (!isInteractive) {
      note(st, 'skipped: no terminal prompt box in this session')
      return r
    }
    const why = whyNotComplete(r.text, r.cursor)
    if (why !== undefined) {
      note(st, `skipped: ${why}`)
      return r
    }
    if (!(await isOn($, INLINE_KEY))) {
      note(st, 'skipped: inline completion is off')
      return r
    }

    const version = st.draftVersion
    const draft = r.text
    const wait = await delayMs($)
    note(st, `waiting ${wait / 1000}s for a pause`)
    idleTimer = $.clock.after(wait, () => {
      if (version !== st.draftVersion) return
      note(st, 'pause reached')
      void requestInline($, st, draft, version)
    })
    return r
  })

  // History recall, a clear, another plugin's fill: whatever was shown is stale.
  on('prompt.change', ($, e, next) => {
    forget()
    return next(e)
  })

  // ---- The band above the prompt (apps without ghost text) ---------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, band)
    if (text === null || e.props.hasSurvey || e.props.isWorking) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>Suggested: {text}</Text>
        <Box>
          <Button
            key="send"
            label="Send"
            onPress={async () => {
              await update($, band, () => null)
              // $.prompt.submit skips this plugin's own prompt.submit hook.
              lastPrompt = text
              generation += 1
              await $.prompt.submit({ text })
            }}
          />
          <Text> </Text>
          <Button key="dismiss" label="Dismiss" onPress={() => update($, band, () => null)} />
        </Box>
      </Box>
    )
  })
}
