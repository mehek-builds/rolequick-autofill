# Litos extension design system

Litos should feel like a focused browser utility: quiet, direct, and trustworthy. The interface supports the workflow without trying to decorate it.

## Principles

1. Use one clear primary action per screen.
2. Prefer sections, rows, and dividers over nested cards.
3. Reserve the brand color for actions, focus, and small status cues.
4. Keep supporting copy readable. Use 12px as the minimum for persistent text.
5. Show meaningful state with text and semantics, not color alone.
6. Use motion only to explain a transition or confirm an action.

## Foundation

- Typeface: Geist Variable
- Popup size: 380 by 580 pixels
- Page background: white
- Preview and store background: warm gray `#faf9f7`
- Brand action: `brand-600`
- Text: `gray-950` for primary, `gray-600` for supporting copy
- Borders: `gray-200` or `gray-300`
- Radius: `rounded-md` for controls, 10px for the popup preview shell
- Shadow: only the outer popup or store-preview shell may use a soft shadow

The canonical color values live in `tailwind.config.ts`. Shared controls and popup structure live in `src/components/ui.tsx`.

## Components

- `PopupHeader`: consistent title, back navigation, and optional actions
- `fieldClass` and `textAreaClass`: labels required, minimum 44px control height
- `primaryButtonClass`: the screen's main action
- `secondaryButtonClass`: a lower-priority alternative
- `textButtonClass`: compact tertiary actions
- `iconButtonClass`: 40px icon targets with accessible names
- `SectionLabel`: restrained uppercase section headings
- `StatusDot`: supporting status cue, always paired with text

## Interaction and accessibility

- Every visible field label must be programmatically associated with its control.
- Icon-only buttons need an `aria-label`.
- Toggle and selection controls must expose their current state.
- Loading, error, and completion states should be announced to assistive technology.
- Keyboard focus must be visible on every interactive element.
- Respect `prefers-reduced-motion`.

## Avoid

- Gradients, decorative blobs, confetti, glass effects, or floating cards
- Multiple full-width primary buttons on one screen
- Tiny helper text or low-contrast gray copy
- Pill badges for ordinary metadata
- Hover movement on functional controls
- Decorative icons where plain language is clearer
