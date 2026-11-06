import { expect, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Stands in for the engine beneath the plugin: a store, the fork, the prompt box.
function engine(on: any, reply: () => Promise<any> | any) {
  const store = new Map<string, unknown>()
  const shown: string[] = []
  let forks = 0
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'autosuggest' } }))
  on('model.fork', async () => { forks += 1; return { value: await reply() } })
  on('prompt.suggest', (_: any, e: any) => { shown.push(e.text); return { isShown: true } })
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { shown, forks: () => forks, store }
}

const answer = (extra: object = {}) =>
  ({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as any

const answered = (text: string) => ({ isAnswered: true, text, usage: USAGE })

// The suggestion is fire-and-forget; give it a few ticks to land.
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }

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
  const r = await $.prompt.suggest({ text: 'engine guess' })
  expect(r.isShown).toBe(true)
})

test('/autosuggest off stops suggestions and status reports it', async ($, on) => {
  const box = engine(on, () => answered('next thing'))
  const off = await $.command.run({ command: 'autosuggest', args: 'off' } as any)
  expect(off.text).toBe('Autosuggest off.')
  await $.turn.complete(answer())
  await settle()
  expect(box.forks()).toBe(0)
  const status = await $.command.run({ command: 'autosuggest', args: '' } as any)
  expect(status.text).toContain('off')
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

test('an unknown /autosuggest option prints usage', async ($, on) => {
  engine(on, () => answered('x'))
  const r = await $.command.run({ command: 'autosuggest', args: 'banana' } as any)
  expect(r.text).toContain('Usage: /autosuggest on | off | status')
})
