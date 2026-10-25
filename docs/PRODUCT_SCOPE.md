# Product scope

ND AI Studio is a proposed development platform with one project system and 24 specialized tool modules. Each tool must be backed by a real processing pipeline before it becomes available. Tool names describe product goals, not verified current capabilities.

## Create: 17 tools

| Tool | Intended result | Completion requirements |
| --- | --- | --- |
| AI Script Generator | Editable Lua resources for ESX, QBCore, Qbox, vRP, ND_Framework, or standalone use, with optional ox_lib integrations | Preserve selected architecture; validate manifest, file references, syntax, client/server boundaries, callbacks, exports, and database paths. |
| Discord Bot Generator | A discord.js project, with standalone or separately validated FiveM-resource targets | Compile and run a controlled smoke test; keep tokens outside generated source; report target-specific limitations. |
| 3D Generator | Text- or image-guided prop creation | Validate mesh, textures, materials, scale, collision, GTA-format output, and resource packaging before calling it server-ready. |
| AI Animations | Video-guided animation creation and .ycd export | Validate motion extraction, skeleton mapping, retargeting, export, and supported in-game playback. |
| Image Generator | Textures, visual concepts, and thumbnails | Return actual image files and preserve generation settings and provenance. |
| Image Editor | Edit uploaded colors, text, or backgrounds | Keep the original, save revisions, and provide before/after inspection. |
| EUP Maker | Design clothing using compatible templates | Use permitted assets, preserve UV alignment, and validate target model and texture compatibility. |
| Animation Builder | Pose-based animation editor | Support a timeline, keyframes, rig preview, and a tested export path. |
| Interior Builder | Compose walk-in environments from an asset catalog | Provide placement, collision review, saved scenes, and supported resource exports. Report the actual catalog size; do not copy another service's prop count. |
| Prop Studio | Configure moving doors, gates, and mechanical props | Separate entity transforms, runtime control scripts, and skeletal animation where appropriate; validate the chosen approach. |
| Prop Reskin | Retexture supported existing props | Preserve UVs and required texture names and formats; show a model preview when supported. |
| Tattoo Studio | Package PNG tattoos or patches with appearance integrations | Validate placement and required metadata; support only explicitly tested script versions. |
| Livery Studio | Design textures for compatible vehicle templates | Preserve UV alignment and texture identifiers; distinguish retexturing from model changes needed for new material slots. |
| Weapon Studio | Create game-only weapon assets and add-on packages | Validate the selected game asset workflow, materials, textures, metadata, and in-game behavior. |
| Ped Creator | Create rigged add-on character packages | Validate geometry, rig, skin weights, materials, export, metadata, and a controlled spawn test. |
| Handling Editor | Edit handling.meta with preview estimates | Label calculated speed, acceleration, and lap estimates as estimates; distinguish them from measured in-game telemetry. |
| Inventory Icons | Export item icons for supported inventory systems | Support transparent output, size presets, deterministic names, and explicit target integration profiles. |

## Convert and bundle: 4 tools

| Tool | Intended result | Completion requirements |
| --- | --- | --- |
| Framework Converter | Convert between supported ESX, QBCore, Qbox, and ox_core targets | Pin framework versions; report unsupported APIs and behavior; review permissions, events, persistence, and dependencies. |
| GLB to FiveM | Convert supported GLB/FBX inputs into appropriate YDR, YTD, YTYP, and YBN outputs | Perform real conversion and validation. Not every source supports every output. Never rename an extension and report success. |
| Resource Merger | Combine compatible packs into a resource | Detect naming, manifest, dependency, load-order, and runtime conflicts. Leave encrypted or incompatible inputs unresolved with an actionable report. |
| EUP Merger | Combine compatible clothing packs | Resolve identifiers and references consistently; validate collisions, target limits, and compatibility rather than only renaming files. |

## Browse: 3 tools

| Tool | Intended result | Completion requirements |
| --- | --- | --- |
| Model Library | Browse and import permitted models | Keep source URLs, authors, license terms, attribution, and conversion status per asset. Free download does not establish redistribution rights. |
| Community Gallery | Publish and browse opted-in projects | Private by default; explicit publication, owner controls, moderation, and reporting. |
| Free Scripts | Browse downloadable released resources | Show version, dependencies, license, install notes, and actual validation status. |

## Shared project behavior

Every project keeps its input files, revisions, diffs, job history, validation results, and downloadable artifacts. Tools may share a project, but every job must declare its input revision, processing module, budget, and expected outputs.

Code builds may use Planning, Writing, Checking, Fixing, and Packaging stages. Asset pipelines should use stages that describe their actual work. All stages must come from persisted worker events, not timers or invented progress percentages.

The platform must distinguish generated, statically validated, smoke-tested, and game-runtime-tested outputs. A ZIP file alone is not proof that a resource works.
