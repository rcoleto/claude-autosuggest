/** The next-prompt suggestion shown in the band above the prompt, or null. */
export type BandSuggestion = string | null

declare module 'claude-code' {
  interface PluginState {
    autosuggest: { band: BandSuggestion }
  }
}
