import type { Register } from 'claude-code'

const ENABLED_KEY = 'enabled'
const MAX_CHARS = 220

// Asks for haste in the prompt instead of passing `effort`: a fork that names
// no effort reuses the main thread's prompt cache on every model.
const ASK = `[autosuggest] You have no tools for this message. Do not continue the
work. Answer straight away, without thinking it over.
Predict the single next message the USER is most likely to type to you now,
given everything above. Write it exactly as the user would: first person,
imperative or question, in the same language the user has been writing in,
one sentence, under 30 words, concrete (name the files, findings or next step
from this conversation). No quotes, no labels, no preamble, no explanation.
If there is no clear useful next step, reply with exactly: NONE`

const LABEL = /^(user|you|me|next( prompt| message)?|suggestion|prompt)\s*:\s*/i
const WRAP = /^[\s"'`“”*_]+|[\s"'`“”*_]+$/g

export function clean(raw: string): string | undefined {
  let text = raw.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
  text = text.replace(WRAP, '').trim().replace(LABEL, '').replace(WRAP, '').trim()
  if (text === '' || /^none\.?$/i.test(text)) return undefined
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text
}

export const register: Register = on => {
  // Bumped on every new prompt, so a suggestion computed for an older turn is dropped.
  let generation = 0
  // Headless runs (claude -p, the SDK) have no prompt box: skip the paid fork there.
  let isInteractive = true
  // Guards against a fork's own completion re-entering this hook.
  let isForking = false

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.command.register({
      name: 'autosuggest',
      description: 'Next-prompt suggestions: /autosuggest on | off | status',
    })
    return next(e)
  })

  on('command.run', { command: 'autosuggest' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await $.store.set(ENABLED_KEY, arg === 'on')
      return { text: `Autosuggest ${arg}.` }
    }
    const state = `Autosuggest is ${((await $.store.get(ENABLED_KEY)) !== false) ? 'on' : 'off'}.`
    if (arg === '' || arg === 'status') return { text: state }
    return { text: `Unknown option "${arg}". ${state} Usage: /autosuggest on | off | status` }
  })

  on('prompt.submit', ($, e, next) => {
    generation += 1
    return next(e)
  })

  // While on, this plugin owns the ghost text: hide the engine's built-in guess
  // so the two don't race for the same slot.
  on('prompt.suggest', async ($, e, next) => {
    if (e.origin.kind === 'suggestion' && ((await $.store.get(ENABLED_KEY)) !== false)) {
      return { isShown: false }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Main loop only, only after a real answer, only where a box can show it.
    if (e.agentId !== undefined || e.reason !== 'answer') return result
    if (!isInteractive || isForking || (await $.store.get(ENABLED_KEY)) === false) return result

    const mine = ++generation
    // Fire and forget: the box only shows a suggestion once the turn is over.
    void (async () => {
      isForking = true
      try {
        const reply = await $.model.fork({ prompt: ASK })
        if (mine !== generation || !reply.isAnswered) return
        const text = clean(reply.text)
        if (text !== undefined) await $.prompt.suggest({ text })
      } catch (err) {
        $.ui.log(`autosuggest: ${String(err)}`, { to: 'debug' })
      } finally {
        isForking = false
      }
    })()
    return result
  })
}
