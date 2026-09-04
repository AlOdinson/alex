# Alex Board Bilingual UI Design

## Goal

Add complete Russian/English interface localization to Alex Board with independent language choice for teachers and students.

## User experience

### Teacher

- The Home screen shows a compact `RU | EN` language switcher near the main board-creation/library controls.
- The selected teacher language applies to the complete teacher-facing interface: Home, board creation, board library, board toolbar, menus, dialogs, prompts, confirmations, tooltips, placeholders, sync/save states, screen sharing, game UI, account UI, export UI, and all other visible system copy.
- The teacher language choice is persisted locally on that device/browser and restored on later visits.
- Existing installations default to Russian when no saved preference exists.

### Student

- When a student opens a board invite link and reaches the join/name-entry screen, the first visible choice includes `RU | EN`.
- Choosing a language immediately localizes the join screen itself, including the name-field label/placeholder, buttons, errors, and instructions.
- After entering the board, the same language is used for the complete student-facing board interface.
- A `RU | EN` switcher remains available inside the board so the student can change language later.
- A student's language is independent from the teacher's language and from other students' language choices.
- The student language choice is persisted locally on that device/browser.

## Localization architecture

Create one small localization module responsible for:

1. supported languages (`ru`, `en`),
2. persisted language preferences,
3. translation lookup,
4. interpolation/plural-friendly helpers where dynamic values are needed,
5. locale-specific date/time formatting.

UI components consume translations through a shared React context/hook instead of embedding language-conditionals throughout components.

Use stable semantic translation keys grouped by area, for example:

- `home.*`
- `join.*`
- `toolbar.*`
- `board.*`
- `share.*`
- `screenShare.*`
- `games.*`
- `account.*`
- `export.*`
- `errors.*`
- `common.*`

No external i18n dependency is required for two languages; keep the implementation local and lightweight.

## Preference model

Maintain separate local preferences so teacher and student choices cannot overwrite each other:

- teacher preference key: `alex-board-language-teacher`
- student preference key: `alex-board-language-student`

Teacher-facing Home initializes from the teacher key. A board session initializes the language according to role: owner/editor teacher uses the teacher key; student/join flow uses the student key.

If role is not yet known on initial board render, the join screen uses the student preference and the authenticated/owner path uses the teacher preference once ownership is resolved.

## Scope of translated content

All user-facing static/system-generated text must have RU and EN variants, including:

- buttons and navigation labels,
- tool names,
- menus and submenu items,
- labels and placeholders,
- title/aria-label tooltip text,
- empty states and helper descriptions,
- save/sync/network status text,
- errors and warnings,
- browser `alert`, `confirm`, and `prompt` copy,
- screen sharing and remote-browser UI,
- game library UI,
- teacher account UI,
- drawing presets and shape labels,
- export/share UI,
- board entry/name screen,
- date/time presentation.

User-created content is never translated: board titles, student names, canvas text, uploaded content, filenames, and other user-entered values remain exactly as entered.

Internal logs, developer comments, database errors intended only for diagnostics, SQL, and documentation are outside the localization requirement unless they are surfaced directly to users.

## Date/time behavior

- Russian UI uses Russian locale formatting.
- English UI uses English locale formatting.
- Existing timestamps are not changed; only presentation changes.

## Migration and compatibility

- Do not change board data schema or collaboration protocol.
- Do not put language into board metadata because language is a per-user display preference, not a property of a board.
- Existing board links remain compatible.
- Existing teacher users see Russian by default until they select English.
- Existing student links continue to work; students gain the language choice before entering.

## Testing

Add regression coverage that verifies:

1. both `ru` and `en` dictionaries contain matching key sets,
2. translation lookup falls back safely and does not render raw missing keys silently,
3. teacher and student preferences are stored independently,
4. date formatting follows the selected locale,
5. major screens/components do not retain hard-coded Cyrillic user-facing text outside the translation catalog,
6. current synchronization/collaboration tests continue to pass,
7. production build succeeds.

Manual smoke checks should cover teacher Home, creating/opening a board, student join flow, in-board language switching, toolbar/dialogs, Screen Share, Games, export/share, and persistence after reload.

## Non-goals

- Automatic language detection from browser locale.
- More than Russian and English in this iteration.
- Machine translation of user-created canvas content or board names.
- Synchronizing language preference across devices/accounts through Supabase.
