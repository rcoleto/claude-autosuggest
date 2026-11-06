# autosuggest

After Claude answers, you often know what you'll type next: "run the tests", "open a PR".
This plugin makes that guess for you and puts it in the empty prompt box as dim text, like
Codex does. Tab takes it. Typing anything else makes it go away.

```
> Rode os testes que você acabou de escrever          ← dim, Tab to accept
```

## Install

At a Claude Code prompt:

```
/plugin install autosuggest --marketplace rcoleto/claude-autosuggest
```

Answer `y` to add the marketplace, then pick a scope (user scope is the usual choice).

From a shell:

```bash
claude plugin install autosuggest --marketplace rcoleto/claude-autosuggest
```

In the desktop app, where `/plugin` isn't available, click **+** next to the prompt box, then
**Plugins** > **Add marketplace**, enter `rcoleto/claude-autosuggest`, and click **Add plugin**.

## Using it

There's nothing to configure. A second or two after each reply, a suggestion shows up in the
box. Tab or → moves it into the box so you can edit it before sending. When the plugin can't
find a clear next step, it leaves the box empty.

Suggestions are written in the language you've been using with Claude.

### Commands

| Command | What it does |
| --- | --- |
| `/autosuggest on` | Turn suggestions on (the default) |
| `/autosuggest off` | Turn them off and go back to Claude Code's built-in suggestions |
| `/autosuggest` | Show whether it's on |

The on/off choice is saved across sessions.

## How it works

At the end of each turn the plugin sends one short extra request to the model. It reuses the
conversation Claude Code just sent, so the API reads nearly all of it from the prompt cache.
The model gets no tools for this request and is told to answer immediately with the one
message you're most likely to type next, in under 30 words, naming the files or findings from
the conversation.

Before the reply reaches the prompt box, the plugin strips quotes, labels like `User:` and
markdown from it.

The plugin doesn't make the request after subagent turns, interrupted turns or turns that
ended in an error. It also stays quiet in headless runs (`claude -p`, the Agent SDK), since
there's no prompt box to show anything in. If you send a new message while a suggestion is
still being generated, the plugin throws that suggestion away so it can't show up under the
wrong turn.

## Cost

Each reply costs one extra request: a cached read of the conversation plus a few dozen output
tokens. Over a long session that adds up a little. `/autosuggest off` stops it.

## Known limitations

- While the plugin is on, it hides Claude Code's own next-prompt suggestion so the two don't
  compete for the box. On a turn where the plugin has no suggestion, the box stays empty.
- Suggestions only appear when the box is empty and Claude isn't working.

## Development

```bash
claude plugin validate .
claude plugin test .
```

The tests in `tests/` run the plugin inside Claude Code's plugin engine, with the model and
the prompt box replaced by stubs.

## License

MIT
