# Original design system

## Direction

A focused Nightz Development workspace with near-black surfaces, charcoal panels, red interaction accents, and readable neutral typography. Use the supplied concept for visual direction, but implement a real interface with original layouts and components.

Do not reproduce the reference service's branding, mascot, mobile page structure, copy, or exact component arrangements. Do not turn every screen into a marketing banner. The home screen can use a branded visual; working editors should prioritize usable space.

## Visual tokens

These are proposed design tokens, not an existing CSS implementation.

| Token | Value | Use |
| --- | --- | --- |
| Background | #09090B | Application canvas |
| Surface | #111115 | Navigation and main panels |
| Raised surface | #19191F | Controls, dialogs, and selected cards |
| Border | #2A2A33 | Panel and input separation |
| Primary text | #F4F4F5 | Headings and body text |
| Secondary text | #A6A6B0 | Metadata and supporting text |
| Accent | #F04452 | Selected states and focus treatment |
| Primary action | #BE123C | Filled buttons with white labels |
| Success | #4ADE80 | Successful validation |
| Warning | #FBBF24 | Unresolved checks and cautions |
| Error | #FB7185 | Failed jobs and inline errors |

Use a consistent 4 px spacing scale and restrained 10-14 px corner radii. Prefer self-hosted, properly licensed fonts or the operating system sans-serif stack. Use a monospace stack for code, logs, file paths, and technical metadata.

No Bootstrap, Tailwind, jQuery, or copied templates. Use modular CSS and semantic HTML. Avoid excessive glow, glass effects that reduce contrast, and ornamental animation during coding work.

## Application shell

### Desktop

A compact left sidebar, global command/search header, broad main workspace, and optional right context panel. Sidebar destinations should be Home, Tools, Projects, Assets, Community, and Settings. Credits are account metadata, not a separate primary workflow.

The home view contains a restrained branded introduction, a prominent project action, recent projects, and tool discovery. Tool previews may use licensed imagery, but cards must remain legible without thumbnails.

### Tablet

Collapse navigation into an icon rail or drawer and move the right context panel into a toggleable section. Preserve editor space instead of compressing three full columns.

### Mobile

Use a compact header with a navigation drawer and project action. Keep search visible on tool discovery screens. Present workspace panels as accessible tabs with a persistent project title and job-state indicator. Avoid copying the reference screenshot's fixed four-item bottom navigation.

Support safe-area insets, dynamic viewport height, keyboard resizing, and usable touch targets. Let users inspect files and job status without a desktop-only layout.

## Key screens

1. Home: project entry points, recently edited work, and active jobs.
2. Tool directory: categories, search, real availability status, and clear output descriptions.
3. New project: tool selection, framework/target, requirements, uploads, and explicit estimated usage where available.
4. Coding workspace: file tree, code/diff editor, task conversation, validation panel, and build log.
5. Asset workspace: appropriate 2D or 3D preview, inspector, timeline when needed, and export settings.
6. Project history: immutable revisions, artifacts, validation evidence, and restoration controls.
7. Account and usage: actual usage, billing status, and limits without invented balances.

## Interaction rules

Show keyboard focus, disabled reasons, upload progress, retry actions, and recoverable error states. Do not hide critical information behind hover alone. Respect reduced-motion preferences. Preserve readable contrast and test keyboard and screen-reader navigation.

Progress reflects real events. Stop requests must show cancellation pending until workers confirm termination. Reconnecting to a job must restore persisted state and logs.

The image's credit balance, sample projects, subscription offer, and tool availability are concept content only. Real screens must read actual data or clearly indicate an empty/unavailable state.

## Build review

Check desktop, tablet, and mobile layouts; long project names; empty catalogs; failed uploads; offline reconnection; cancelled jobs; keyboard-only use; and very large file trees. Text should use ordinary hyphens, not em or en dashes.
