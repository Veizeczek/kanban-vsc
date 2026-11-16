# Security and data safety

## Scope

Kanban VSC reads documents from `docs/` in the first local workspace folder. It does not send task contents to a cloud service or implement telemetry. The repository link opens only after a user action. Git operations use the local Git executable and configuration.

The extension requires Workspace Trust and does not support virtual workspaces. Trust only repositories you control or have reviewed: **Save** invokes Git, whose configured hooks, filters and signing programs may execute code. See [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust).

## File operations

| Action | Effect |
| --- | --- |
| Open, Refresh, automatic file watcher, search, sort | Reads documents; does not rename, move or rewrite them. UI preferences may be saved in VS Code state. |
| Create task | Creates a new Markdown file exclusively; existing names receive a numeric suffix. |
| Move card | Writes a new Markdown file with updated status, then removes the source. An interrupted move may leave two copies. |
| Pin or edit goals | Replaces the document using a temporary file in the same directory. Unsaved editor changes block the operation. |
| Delete document | Requests VS Code's trash operation; errors are reported without falling back to permanent deletion. |
| Initialize | Creates missing project scaffolding when `docs/` is absent; leaves existing documents and `.gitignore` unchanged. |
| Save | Stages `docs/` and creates a local commit scoped to that path. Respects Git ignore rules; does not push. Unrelated staged changes are not included. |

Paths received from webviews are checked against managed documents. Symlinked directories/files and hard-linked files are not writable. Invalid statuses and goal indices are rejected. Creation uses exclusive writes so a destination that appears after the initial check is not overwritten. Non-Markdown root documents can be opened or deleted, but cannot be dragged into task columns.

The Goals editor supports `##` sections and plain `- [ ]` / `- [x]` lists. Explicit edits serialize this structure, normalize whitespace and place completed items last. Use a separate Markdown document for complex formatting such as nested checklists or fenced examples. Refresh never serializes goals.

## Review performed on 2026-11-11

The review covered extension activation, both webview message handlers, filesystem operations, HTML escaping and content security policy, Git save behavior, and VSIX inclusion rules. Changes address:

- Refresh previously renamed/moved task files from frontmatter and rewrote goals.
- Delete and move messages previously accepted paths without checking document ownership.
- Symlinked status directories and goals could point outside the workspace.
- Direct writes could overwrite unsaved editor work or truncate an existing file on write failure.
- Git Save force-added ignored content; initialization automatically ignored the entire docs directory.
- Invalid webview payloads could throw uncaught errors or select unintended goal positions.
- Package exclusions did not explicitly restrict the release to runtime files and public documentation.

Regression tests cover these paths, including a real temporary Git repository and destination collision injection. This is a code review with automated tests, not an independent penetration test or a guarantee of zero vulnerabilities.

## Limits and release verification

Filesystem checks are not an OS sandbox. A malicious local process with the same filesystem permissions can race path checks. Cross-process locking and power-loss durability are not guaranteed. Keep backups or version control for important documents. Save commits saved disk contents, not unsaved editor buffers, and failed Git operations can leave docs changes staged.

Before release, inspect the generated VSIX contents and exercise the installed package on Windows and Linux/WSL: trusted and untrusted workspaces, trash behavior, dirty editors, keyboard navigation, both languages, light/dark themes, and all interface scales. Automated webview tests do not replace an actual VS Code smoke test.

## Reporting

For a suspected vulnerability, contact the maintainer privately using GitHub's private vulnerability reporting feature if available. Do not post credentials, private documents, or working exploits in public issues. Use public issues for non-sensitive defects. No response-time commitment is currently offered.
