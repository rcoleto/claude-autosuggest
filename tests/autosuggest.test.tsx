import { expect, mock, test } from 'claude-code/testing'

declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

import { clean, cleanContinuation, shouldComplete } from '../hooks/register'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/**
 * Stands in for the engine beneath the plugin: a store, the model fork, the
 * prompt box (suggest, paint, edits) and a clock that only moves when told.
 */
function engine(
  on: any,
  reply: (prompt: string) => Promise<any> | any,
  opts: { ghost?: boolean; surfaces?: string[]; paintRefused?: boolean } = {},
) {
  const store = new Map<string, unknown>()
  const shown: string[] = []
  const paints: any[] = []
  const prompts: string[] = []
  const submitted: string[] = []
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'autosuggest' } }))
  on('model.fork', async (_: any, e: any) => { prompts.push(e.prompt); return { value: await reply(e.prompt) } })
  // ghost: false stands for a box Claude Code doesn't draw (the desktop app).
  on('prompt.suggest', (_: any, e: any) => {
    if (opts.ghost === false) return { isShown: false }
    shown.push(e.text)
    return { isShown: true }
  })
  on('session.surfaces', () => ({ value: opts.surfaces ?? [] }))
  // What the engine draws where the plugin draws nothing of its own.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.paint', (_: any, e: any) => {
    if (opts.paintRefused) return { value: { isPainted: false, text: '', cursor: 0 } }
    paints.push(e)
    return { value: { isPainted: true, text: e.text ?? '', cursor: (e.text ?? '').length } }
  })
  // The editor: apply the splice, caret after what went in. `box` is what the
  // prompt box holds now, for $.prompt.read.
  const box = { text: '', cursor: 0 }
  on('prompt.edit', (_: any, e: any) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    box.text = text
    box.cursor = e.start + e.inputText.length
    return { text, cursor: box.cursor }
  })
  on('prompt.read', () => ({ value: { ...box } }))
  on('prompt.change', () => undefined)
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  return { shown, paints, prompts, submitted, box, forks: () => prompts.length, store, clock }
}

const answer = (extra: object = {}) =>
  ({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as any

const answered = (text: string) => ({ isAnswered: true, text, usage: USAGE })

/** Types `added` at the end of `before`, as one burst of keys. */
const type = ($: any, before: string, added: string, key?: string) =>
  $.prompt.edit({
    origin: { kind: 'composer' },
    ...(key ? { key: { key } } : {}),
    text: before, cursor: before.length, start: before.length, end: before.length, inputText: added,
  })

/** Presses a key that moves nothing and types nothing, caret at the end. */
const press = ($: any, text: string, key: string) =>
  $.prompt.edit({
    origin: { kind: 'composer' }, key: { key },
    text, cursor: text.length, start: text.length, end: text.length, inputText: '',
  })

// The next-prompt suggestion is fire-and-forget; give it a few ticks to land.
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }

// ===========================================================================
// Next-prompt suggestion (empty box, after a reply)
// ===========================================================================

test('after an answer, the fork text becomes the dim suggestion (quotes stripped)', async ($, on) => {
  const box = engine(on, () => answered('"Rode os testes que você acabou de escrever"\n'))
  await $.turn.complete(answer())
  await settle()
  expect(box.shown).toEqual(['Rode os testes que você acabou de escrever'])
})

test('NONE means no suggestion', async ($, on) => {
  const box = engine(on, () => answered('NONE'))
  await $.turn.complete(answer())
  await settle()
  expect(box.shown).toEqual([])
})

test('subagent turns, aborted turns and errors do not suggest', async ($, on) => {
  const box = engine(on, () => answered('x'))
  await $.turn.complete(answer({ agentId: 'a1' }))
  await $.turn.complete(answer({ reason: 'aborted', isAborted: true }))
  await $.turn.complete(answer({ reason: 'error' }))
  await settle()
  expect(box.forks()).toBe(0)
  expect(box.shown).toEqual([])
})

test('a suggestion that arrives after the next prompt was sent is dropped', async ($, on) => {
  let release: (v: unknown) => void = () => {}
  const box = engine(on, () => new Promise(r => { release = r }))
  await $.turn.complete(answer())
  await $.prompt.submit({ text: 'something else' } as any)
  release(answered('stale idea'))
  await settle()
  expect(box.shown).toEqual([])
})

test('suggestions from other plugins still pass through', async ($, on) => {
  engine(on, () => answered('x'))
  const r = await $.prompt.suggest({ text: 'engine guess' } as any)
  expect(r.isShown).toBe(true)
})

test('labels and markdown around the guess are stripped', async ($, on) => {
  const box = engine(on, () => answered('**User:** "Abra um PR com essas mudanças"'))
  await $.turn.complete(answer())
  await settle()
  expect(box.shown).toEqual(['Abra um PR com essas mudanças'])
})

test('headless sessions never fork (nothing could show the suggestion)', async ($, on) => {
  const box = engine(on, () => answered('x'))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as any)
  await $.turn.complete(answer())
  await settle()
  expect(box.forks()).toBe(0)
})

test('interactive sessions do fork', async ($, on) => {
  const box = engine(on, () => answered('next'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  await $.turn.complete(answer())
  await settle()
  expect(box.forks()).toBe(1)
  expect(box.shown).toEqual(['next'])
})

test('a failed fork shows nothing and does not throw', async ($, on) => {
  const box = engine(on, () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }))
  const r = await $.turn.complete(answer())
  await settle()
  expect(r.text).toBe('Done.')
  expect(box.shown).toEqual([])
})

test('/autosuggest next off stops only the next-prompt suggestion', async ($, on) => {
  const box = engine(on, () => answered('next thing'))
  const off = await $.command.run({ command: 'autosuggest', args: 'next off' } as any)
  expect(off.text).toBe('Next-prompt suggestions off.')
  await $.turn.complete(answer())
  await settle()
  expect(box.forks()).toBe(0)
  const status = await $.command.run({ command: 'autosuggest', args: '' } as any)
  expect(status.text).toContain('Next-prompt suggestions: off')
  expect(status.text).toContain('Inline completion: on')
})

test('/autosuggest off turns everything off', async ($, on) => {
  const box = engine(on, () => answered('x'))
  await $.command.run({ command: 'autosuggest', args: 'off' } as any)
  await $.turn.complete(answer())
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(10000)
  await settle()
  expect(box.forks()).toBe(0)
  const status = await $.command.run({ command: 'autosuggest', args: 'status' } as any)
  expect(status.text).toContain('off')
})

test('an unknown /autosuggest option prints usage', async ($, on) => {
  engine(on, () => answered('x'))
  const r = await $.command.run({ command: 'autosuggest', args: 'banana' } as any)
  expect(r.text).toContain('Unknown option "banana"')
  expect(r.text).toContain('/autosuggest delay <seconds>')
})

// ===========================================================================
// Inline completion (half-written draft, after a pause)
// ===========================================================================

test('after a 2s pause, the continuation is painted dim after the draft', async ($, on) => {
  const box = engine(on, () => answered(' arquivo de login'))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(1999)
  expect(box.forks()).toBe(0)
  await box.clock.advance(1)
  await settle()
  expect(box.forks()).toBe(1)
  expect(box.prompts[0]).toContain('Corrige o bug no')
  expect(box.paints).toEqual([{
    text: 'Corrige o bug no',
    decorations: [{ start: 16, end: 16, virtualText: ' arquivo de login', dimColor: true }],
  }])
})

test('typing again restarts the wait', async ($, on) => {
  const box = engine(on, () => answered(' x'))
  await type($, '', 'Corrige o')
  await box.clock.advance(1500)
  await type($, 'Corrige o', ' bug')
  await box.clock.advance(1500)
  expect(box.forks()).toBe(0)
  await box.clock.advance(500)
  await settle()
  expect(box.forks()).toBe(1)
  expect(box.prompts[0]).toContain('Corrige o bug')
})

test('a draft ending with a period gets no completion', async ($, on) => {
  const box = engine(on, () => answered(' x'))
  await type($, '', 'Corrige o bug no login.')
  await box.clock.advance(10000)
  await type($, 'Corrige o bug no login.', ' ')
  await box.clock.advance(10000)
  await settle()
  expect(box.forks()).toBe(0)
})

test('slash commands, shell lines and very short drafts get no completion', async ($, on) => {
  const box = engine(on, () => answered(' x'))
  await type($, '', '/compact keep')
  await box.clock.advance(5000)
  await type($, '', '!git status')
  await box.clock.advance(5000)
  await type($, '', 'faz')
  await box.clock.advance(5000)
  await settle()
  expect(box.forks()).toBe(0)
})

test('a completion that arrives after more typing is dropped', async ($, on) => {
  let release: (v: unknown) => void = () => {}
  const box = engine(on, () => new Promise(r => { release = r }))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  expect(box.forks()).toBe(1)
  await type($, 'Corrige o bug no', ' log')
  release(answered(' arquivo de login'))
  await settle()
  expect(box.paints).toEqual([])
})

test('Tab takes the completion', async ($, on) => {
  const box = engine(on, () => answered(' arquivo de login'))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  const r = await press($, 'Corrige o bug no', 'tab')
  expect(r.text).toBe('Corrige o bug no arquivo de login')
  expect(r.cursor).toBe(r.text.length)
})

test('→ at the end of the draft takes the completion too', async ($, on) => {
  const box = engine(on, () => answered(' arquivo de login'))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  const r = await press($, 'Corrige o bug no', 'right')
  expect(r.text).toBe('Corrige o bug no arquivo de login')
})

test('Tab with nothing shown is left to the editor', async ($, on) => {
  engine(on, () => answered(' x'))
  const r = await press($, 'Corrige o bug no', 'tab')
  expect(r.text).toBe('Corrige o bug no')
})

test('typing the shown characters keeps the rest of the completion on screen', async ($, on) => {
  const box = engine(on, () => answered(' arquivo de login'))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  const r = await type($, 'Corrige o bug no', ' arq', 'q')
  expect(r.text).toBe('Corrige o bug no arq')
  expect(r.decorations).toEqual([{ start: 20, end: 20, virtualText: 'uivo de login', dimColor: true }])
  // ...and Tab still takes what's left.
  const taken = await press($, 'Corrige o bug no arq', 'tab')
  expect(taken.text).toBe('Corrige o bug no arquivo de login')
})

test('typing something different drops the completion', async ($, on) => {
  const box = engine(on, () => answered(' arquivo de login'))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  const r = await type($, 'Corrige o bug no', ' checkout')
  expect(r.decorations).toBeUndefined()
  const tab = await press($, 'Corrige o bug no checkout', 'tab')
  expect(tab.text).toBe('Corrige o bug no checkout')
})

test('/autosuggest inline off stops inline completion', async ($, on) => {
  const box = engine(on, () => answered(' x'))
  const r = await $.command.run({ command: 'autosuggest', args: 'inline off' } as any)
  expect(r.text).toBe('Inline completion off.')
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(10000)
  await settle()
  expect(box.forks()).toBe(0)
})

test('/autosuggest delay changes the wait (and is clamped)', async ($, on) => {
  const box = engine(on, () => answered(' x'))
  const r = await $.command.run({ command: 'autosuggest', args: 'delay 5' } as any)
  expect(r.text).toBe('Inline completion now waits 5s after you stop typing.')
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(4999)
  expect(box.forks()).toBe(0)
  await box.clock.advance(1)
  await settle()
  expect(box.forks()).toBe(1)
  const tiny = await $.command.run({ command: 'autosuggest', args: 'delay 0.1' } as any)
  expect(tiny.text).toContain('0.5s')
  const bad = await $.command.run({ command: 'autosuggest', args: 'delay soon' } as any)
  expect(bad.text).toContain(`isn't a number`)
})

test('headless sessions never complete inline', async ($, on) => {
  const box = engine(on, () => answered(' x'))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as any)
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(10000)
  await settle()
  expect(box.forks()).toBe(0)
})

// ===========================================================================
// Pure helpers
// ===========================================================================

test('cleanContinuation keeps the model\'s leading space and drops echoes', () => {
  expect(cleanContinuation(' arquivo de login', 'Corrige o bug no')).toBe(' arquivo de login')
  expect(cleanContinuation('ivo de login', 'Corrige o bug no arqu')).toBe('ivo de login')
  expect(cleanContinuation('Corrige o bug no arquivo', 'Corrige o bug no')).toBe(' arquivo')
  expect(cleanContinuation(' arquivo', 'Corrige o bug no ')).toBe('arquivo')
  expect(cleanContinuation('"arquivo"', 'Corrige o bug no ')).toBe('arquivo')
  expect(cleanContinuation('NONE', 'Corrige')).toBeUndefined()
  expect(cleanContinuation('   ', 'Corrige')).toBeUndefined()
  expect(cleanContinuation(' ' + 'palavra '.repeat(40), 'x')!.length).toBeLessThanOrEqual(140)
})

test('shouldComplete', () => {
  expect(shouldComplete('Corrige o bug no', 16)).toBe(true)
  expect(shouldComplete('Corrige o bug no', 3)).toBe(false)
  expect(shouldComplete('Corrige o bug.', 14)).toBe(false)
  expect(shouldComplete('Corrige o bug.  ', 16)).toBe(false)
  expect(shouldComplete('Pronto? E agora', 15)).toBe(true)
  expect(shouldComplete('/review', 7)).toBe(false)
  expect(shouldComplete('ok', 2)).toBe(false)
})

// ===========================================================================
// Smarter suggestions
// ===========================================================================

test('the SUGGESTION line is used and the WHY line is never shown', async ($, on) => {
  const box = engine(on, () => answered('WHY: rule 1, you offered to push\nSUGGESTION: sim, pode fazer o push'))
  await $.turn.complete(answer())
  await settle()
  expect(box.shown).toEqual(['sim, pode fazer o push'])
})

test('the next-prompt request asks for the user\'s own style and answers to open questions', async ($, on) => {
  const box = engine(on, () => answered('SUGGESTION: NONE'))
  await $.turn.complete(answer())
  await settle()
  expect(box.prompts[0]).toContain("Copy the USER's own writing style")
  expect(box.prompts[0]).toContain('asked the user a question or offered options')
  expect(box.shown).toEqual([])
})

test('a suggestion that repeats the last message sent is dropped', async ($, on) => {
  const box = engine(on, () => answered('SUGGESTION: Faz o push!'))
  await $.prompt.submit({ text: 'faz o push' } as any)
  await $.turn.complete(answer())
  await settle()
  expect(box.shown).toEqual([])
})

test('the inline request carries the style rule too', async ($, on) => {
  const box = engine(on, () => answered(' arquivo de login'))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  expect(box.prompts[0]).toContain("Copy the USER's own writing style")
  expect(box.prompts[0]).toContain('real names of')
})

test('clean: formats, generic acknowledgements and repeats', () => {
  expect(clean('WHY: x\nSUGGESTION: roda os testes')).toBe('roda os testes')
  expect(clean('**SUGGESTION:** "roda os testes"')).toBe('roda os testes')
  expect(clean('SUGGESTION: NONE')).toBeUndefined()
  expect(clean('WHY: nothing left')).toBeUndefined()
  expect(clean('roda os testes')).toBe('roda os testes')
  expect(clean('SUGGESTION: ok, obrigado!')).toBeUndefined()
  expect(clean('SUGGESTION: valeu')).toBeUndefined()
  expect(clean('SUGGESTION: sim')).toBe('sim')
  expect(clean('SUGGESTION: continua')).toBe('continua')
  expect(clean('SUGGESTION: Faz o push.', 'faz o push')).toBeUndefined()
  expect(clean('SUGGESTION: faz o push e abre o PR', 'faz o push')).toBe('faz o push e abre o PR')
})

// ===========================================================================
// Desktop app: the band above the prompt
// ===========================================================================

const BAND = {
  plugin: 'autosuggest',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

/** A desktop-app session: no terminal REPL, the app attached, no ghost text. */
const desktop = async ($: any, on: any, reply: () => any) => {
  const box = engine(on, reply, { ghost: false, surfaces: ['desktop'] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false } as any)
  return box
}

test('in the desktop app the suggestion goes to the band above the prompt', async ($, on) => {
  await desktop($, on, () => answered('SUGGESTION: roda os testes'))
  await $.turn.complete(answer())
  await settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /Suggested/ }))?.text).toBe('Suggested: roda os testes')
  await ui.unmount()
})

test('Send submits the suggestion as the next prompt and clears the band', async ($, on) => {
  const box = await desktop($, on, () => answered('SUGGESTION: roda os testes'))
  await $.turn.complete(answer())
  await settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'send' })
  expect(box.submitted).toEqual(['roda os testes'])
  expect(await ui.find({ type: 'Text', text: /Suggested/ })).toBeUndefined()
  await ui.unmount()
})

test('Dismiss clears the band without sending', async ($, on) => {
  const box = await desktop($, on, () => answered('SUGGESTION: roda os testes'))
  await $.turn.complete(answer())
  await settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'dismiss' })
  expect(box.submitted).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Suggested/ })).toBeUndefined()
  await ui.unmount()
})

test('the band hides while Claude is working and after a new prompt', async ($, on) => {
  await desktop($, on, () => answered('SUGGESTION: roda os testes'))
  await $.turn.complete(answer())
  await settle()
  const busy = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'desktop' } as any)
  expect(await busy.find({ type: 'Text', text: /Suggested/ })).toBeUndefined()
  await busy.unmount()
  await $.prompt.submit({ text: 'outra coisa' } as any)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Text', text: /Suggested/ })).toBeUndefined()
  await ui.unmount()
})

test('in the terminal the ghost text is used and the band stays empty', async ($, on) => {
  const box = engine(on, () => answered('SUGGESTION: roda os testes'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  await $.turn.complete(answer())
  await settle()
  expect(box.shown).toEqual(['roda os testes'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /Suggested/ })).toBeUndefined()
  await ui.unmount()
})

test('no terminal and no app attached: no request at all', async ($, on) => {
  const box = engine(on, () => answered('SUGGESTION: x'), { ghost: false, surfaces: [] })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as any)
  await $.turn.complete(answer())
  await settle()
  expect(box.forks()).toBe(0)
})

// ===========================================================================
// /autosuggest debug
// ===========================================================================

const debug = async ($: any) => (await $.command.run({ command: 'autosuggest', args: 'debug' } as any)).text as string

test('debug shows every step of a successful inline completion', async ($, on) => {
  const box = engine(on, () => answered(' arquivo de login'))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  const out = await debug($)
  expect(out).toContain('edit (paste/burst): box "Corrige o bug no", cursor 16/16')
  expect(out).toContain('waiting 2s for a pause')
  expect(out).toContain('pause reached')
  expect(out).toContain('asking the model to continue "Corrige o bug no"')
  expect(out).toContain('model replied " arquivo de login"')
  expect(out).toContain('painted " arquivo de login" after the draft')
})

test('debug names why a draft was skipped', async ($, on) => {
  engine(on, () => answered(' x'))
  await type($, '', 'Corrige o bug no login.')
  expect(await debug($)).toContain('skipped: draft ends with a period')
})

test('debug says when Claude Code refuses to paint', async ($, on) => {
  const box = engine(on, () => answered(' arquivo'), { paintRefused: true })
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  expect(await debug($)).toContain('not painted: Claude Code refused')
})

test('debug says when the model gives no text', async ($, on) => {
  const box = engine(on, () => ({ isAnswered: false, reason: 'nothing-to-fork', usage: USAGE }))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  expect(await debug($)).toContain('model gave no text: nothing-to-fork')
})

test('debug with nothing yet says no edit reached the plugin', async ($, on) => {
  engine(on, () => answered(' x'))
  expect(await debug($)).toContain('nothing yet: no edit has reached the plugin')
})

test('the box is read before painting, and a changed box drops the completion', async ($, on) => {
  let release: (v: unknown) => void = () => {}
  const box = engine(on, () => new Promise(r => { release = r }))
  await type($, '', 'Corrige o bug no')
  await box.clock.advance(2000)
  await settle()
  // Something outside this plugin's edits changed the box meanwhile.
  box.box.text = 'outra coisa'
  box.box.cursor = 11
  release(answered(' arquivo'))
  await settle()
  expect(box.paints).toEqual([])
  expect(await debug($)).toContain('dropped: the box now reads "outra coisa"')
})
