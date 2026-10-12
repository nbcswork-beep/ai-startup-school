# Student OS controls

All Student App controls come from `src/student-controls.css`; colors come from `src/student-theme.css`.
Do not style a button by its position (`.section button`, `#id`) — pick a variant and a size.

## Buttons

```html
<button type="button" class="btn btn--primary btn--lg">Надіслати домашнє завдання</button>
```

| Variant | Use |
|---|---|
| `btn--primary` | The one main action of a screen or form |
| `btn--secondary` | Supporting actions and resource links |
| `btn--outline` | Optional actions next to a primary one (attach, edit, retry) |
| `btn--ghost` | Low-emphasis navigation: back, "До проєкту", "Позначити всі прочитаними" |
| `btn--danger` | Destructive actions that need weight |
| `btn--icon` | Square icon-only action; always with `aria-label` |

| Size | Height | Padding | Text |
|---|---|---|---|
| `btn--sm` | 44 px | 14 px | 13 px |
| default | 48 px | 18 px | 14 px |
| `btn--lg` | 56 px | 22 px | 15 px |

Modifiers: `btn--block` (full width), `btn--row` (label left, icon right — list actions), `btn--back`.
Every size meets the 44 × 44 px touch target. Long labels wrap inside the button (`text-wrap: balance`)
instead of overflowing; the height grows, the padding stays.

States are built in: hover (only on hover-capable pointers), pressed (1 px shift), `:focus-visible`
(2 px cyan ring), `:disabled`, `aria-busy="true"` (spinner; set by `performUiAction`),
`data-action-state="success" | "error"`. Reduced motion removes the shift and spinner animation.

## Interactive cards

Whole-card actions (`.card-action`, `.lesson-node`, `.homework-row`, `.homework-pulse`,
`.notification-item`, `.profile-links button`, `.mentor-slot`, `.suggestion`, `.nav-item`) share the same
focus ring, hover surface and disabled cursor. A card is one button; arrows inside it are decoration.

## Fields

`.field` > `.field-label` + input/textarea: 48 px minimum height, 16 px text (no iOS zoom), cyan focus.
Optional fields add `<span class="field-hint">за потреби</span>` to the label.

## Homework statuses

`homeworkStatus()` in `src/main.js` is the single vocabulary: Нове, Чернетка, На перевірці, Перевірено,
На доопрацюванні. It drives the status pill, the Learning list and the Home card.
