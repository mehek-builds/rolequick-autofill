# Visual preview harness (dev only)

A standalone page that renders every popup screen side-by-side with mock data,
so you can eyeball the UI without loading the extension into Chrome or running
the real backend. Not part of the production build (WXT only bundles `src/`).

## Run it

```bash
npm run preview
```

This starts:
- a tiny mock backend on `:3001` (`preview/mock-server.mjs`) so the screens that
  fetch on mount (Main, Draft editor, Tracking) populate with canned data
- a Vite dev server on `:4700`

Then open **http://localhost:4700/preview.html**.

For Chrome Web Store canvases, add `?store=onboarding`, `?store=main`, or
`?store=contacts`. Each route renders a 1280 by 800 store image around the
corresponding popup state.

## Files
- `preview.html` / `preview.tsx` (repo root) — the harness page; mounts the real
  components from `src/components` with mock props.
- `preview/mock-server.mjs` — hardcoded fake API responses. Edit to change the
  sample contacts, draft, or outreach events.

To add a side-by-side state, drop another `<Frame>` into `preview.tsx`. To add a
store canvas, add the screen and its copy to `storeScreens` in the same file.
