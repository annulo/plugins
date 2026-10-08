# Annulo plugins

Plugins for [Annulo](https://github.com/annulo) projects. A project is a template plus plugins: a plugin is a set of features (local functions, tables, tasks, schedules, skills) that any project can install, and it upgrades on its own.

| Plugin | What you get |
|---|---|
| [`social`](social) | X, LinkedIn, Facebook, Instagram, YouTube, Xiaohongshu, Douyin, Bilibili and Zhihu accounts: log in with this computer's browser, rewrite content into posts for each platform, publish or schedule them after review, and collect engagement and follower numbers. See [`social/PLUGIN.md`](social/PLUGIN.md). |

## Install a plugin

Settings → Project → Plugins. Plugins in this repository are listed there. To install from another repository, enter `<repository>#<directory>`, for example `https://github.com/you/plugins#crm`.

A template can ask for plugins in its `annulo.json`; projects created from it install them automatically:

```json
{ "plugins": { "social": "https://github.com/annulo/plugins#social" } }
```

The plugin lands in the project's `plugins/<id>/`, where the assistant can read and fix it. Upgrades merge the new version into the project and keep the project's own changes. What you install or remove yourself is recorded in `user/annulo.json`.

## Names

Everything a plugin brings is named after its id, so it never clashes with the project:

| In the plugin | In the project |
|---|---|
| `local/x.ts`, function `publish` | local function `social/x.publish` |
| `tables/posts.json` | table `social_posts` |
| `tasks/write-x.md` | task `social/write-x` |
| `schedules/x.collect.json` | schedule `social/x.collect` |

A plugin only imports its own files. Your customizations (for example a rewritten writing prompt) go in `user/plugins/<id>/`; upgrades never touch them.

## Plugin layout

| Path | What it is |
|---|---|
| `plugin.json` | Name, description (`{"zh": …, "en": …}`) and `min_annulo_api`, the Annulo capability version the plugin needs (28 or later) |
| `PLUGIN.md` | Notes for the assistant: what the plugin provides and how a template uses it |
| `local/*.ts` | Local functions |
| `tables/<table>.json` | Data tables |
| `tasks/`, `prompts/` | Jobs handed to the assistant, and their default writing instructions |
| `schedules/` | Scheduled jobs |
| `skills/` | Skills the assistant loads |

The plugin id is the directory name: lowercase letters and digits only.

## Versions

A version is a semver tag (`v1.2.0`) on this repository; pre-releases are not offered. Upgrade notes live in each plugin's `changelog.yaml` (newest first; each entry has a `version` plus one note per language code, e.g. `zh`, `en`), and Annulo shows the one matching the interface language, falling back to `en`. Write the tag message in English; it is shown only when `changelog.yaml` has no entry for that version. Every tag must contain finished plugins: Annulo copies the directory as it is at the tag.

## License

[Apache-2.0](LICENSE)
