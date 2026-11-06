import type { EngineInterface, PromptDecoration, Register } from 'claude-code'

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

const ASK_NEXT = `[autosuggest] You have no tools for this message. Do not continue the
work. Answer straight away, without thinking it over.
Predict the single next message the USER is most likely to type to you now,
given everything above. Write it exactly as the user would: first person,
imperative or question, in the same language the user has been writing in,
one sentence, under 30 words, concrete (name the files, findings or next step
from this conversation). No quotes, no labels, no preamble, no explanation.
If there is no clear useful next step, reply with exactly: NONE`

function askInline(draft: string): string {
  return `[autosuggest] You have no tools for this message. Do not answer the draft
and do not continue the work. Answer straight away, without thinking it over.
The USER is in the middle of typing their next message to you. Their unfinished
draft is between the markers below, exactly as typed:
<<<DRAFT
${draft}
DRAFT>>>
Reply with ONLY the text that should come right after the draft's last
character to finish their thought: same language and tone, at most 15 words,
ending at a natural stopping point. Start with a space if the next word is a new
word; start without one if the draft stops in the middle of a word. Never repeat
the draft. No quotes, no labels, no explanation.
If you can't tell how they'd continue, reply with exactly: NONE`
}

// ---------------------------------------------------------------------------
// Cleaning model output
// ---------------------------------------------------------------------------

const LABEL = /^(user|you|me|next( prompt| message)?|suggestion|prompt|continuation)\s*:\s*/i
const WRAP = /^[\s"'`“”*_]+|[\s"'`“”*_]+$/g
const QUOTES = /^["'`“”]+|["'`“”]+$/g

export function clean(raw: string): string | undefined {
  let text = raw.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
  text = text.replace(WRAP, '').trim().replace(LABEL, '').replace(WRAP, '').trim()
  if (text === '' || /^none\.?$/i.test(text)) return undefined
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
export function shouldComplete(text: string, cursor: number): boolean {
  if (cursor !== text.length) return false
  const trimmed = text.trim()
  if (trimmed.length < MIN_DRAFT_CHARS) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) return false
  if (text.trimEnd().endsWith('.')) return false
  return true
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
}

async function requestInline($: EngineInterface, st: InlineState, draft: string, version: number) {
  if (st.isForking) return
  st.isForking = true
  try {
    const reply = await $.model.fork({ prompt: askInline(draft) })
    if (version !== st.draftVersion || !reply.isAnswered) return
    const text = cleanContinuation(reply.text, draft)
    if (text === undefined) return
    const painted = await $.prompt.paint({
      text: draft,
      decorations: [ghostDecoration(draft.length, text)],
    })
    if (painted.isPainted && version === st.draftVersion) st.ghost = { draft, text }
  } catch (err) {
    $.ui.log(`autosuggest: ${String(err)}`, { to: 'debug' })
  } finally {
    st.isForking = false
  }
}

export const register: Register = on => {
  // Bumped on every prompt sent, so a next-prompt suggestion made for an older
  // turn is dropped.
  let generation = 0
  // Headless runs (claude -p, the SDK) have no prompt box: skip the paid fork.
  let isInteractive = true
  // Guards against a fork's own completion re-entering turn.complete.
  let isForkingNext = false

  const st: InlineState = { draftVersion: 0, ghost: undefined, isForking: false }
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

    if ((first === 'on' || first === 'off') && second === undefined) {
      await $.store.set(ENABLED_KEY, first === 'on')
      if (first === 'off') forget()
      return { text: `Autosuggest ${first}.` }
    }

    if ((first === 'next' || first === 'inline') && (second === 'on' || second === 'off')) {
      await $.store.set(first === 'next' ? NEXT_KEY : INLINE_KEY, second === 'on')
      if (second === 'on') await $.store.set(ENABLED_KEY, true)
      if (first === 'inline' && second === 'off') forget()
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

  on('prompt.submit', ($, e, next) => {
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
    if (!isInteractive || isForkingNext || !(await isOn($, NEXT_KEY))) return result

    const mine = ++generation
    // Fire and forget: the box only shows a suggestion once the turn is over.
    void (async () => {
      isForkingNext = true
      try {
        const reply = await $.model.fork({ prompt: ASK_NEXT })
        if (mine !== generation || !reply.isAnswered) return
        const text = clean(reply.text)
        if (text !== undefined) await $.prompt.suggest({ text })
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

    if (!isInteractive || !shouldComplete(r.text, r.cursor)) return r
    if (!(await isOn($, INLINE_KEY))) return r

    const version = st.draftVersion
    const draft = r.text
    idleTimer = $.clock.after(await delayMs($), () => {
      if (version === st.draftVersion) void requestInline($, st, draft, version)
    })
    return r
  })

  // History recall, a clear, another plugin's fill: whatever was shown is stale.
  on('prompt.change', ($, e, next) => {
    forget()
    return next(e)
  })
}
