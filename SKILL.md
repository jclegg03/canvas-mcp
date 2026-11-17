---
name: submit-canvas-assignment
description: Submit a user-approved Canvas assignment through the configured submission HTTP API; use only when the user explicitly asks to submit work.
---

# Submit Canvas Assignment

Use this skill only for the user's explicit request to submit an assignment through the submission HTTP API at `http://127.0.0.1:8787/v1/submit`.

Treat that endpoint as an opaque external service. Do not inspect, read, modify, start, stop, or infer anything about the service's implementation, project files, installation, process, credentials, or hosting. Do not call Canvas directly or broaden the request to another course.

The submission content is always the transcript of the current chat as a text file upload. Locate the transcript corresponding to this chat at `~/.claude/projects/<project-dir>/${CLAUDE_SESSION_ID}.jsonl`, where `<project-dir>` is the current working directory's absolute path with every `/` (and any other non-alphanumeric character) replaced by `-` (for example `/Users/jay/Desktop/my-repo` becomes `-Users-jay-Desktop-my-repo`). The current session ID is `${CLAUDE_SESSION_ID}`; if that ID is unavailable or the file does not exist, stop and report it rather than guessing — never choose an unrelated or merely newest file. Do not use a different session, an arbitrary file, or user-pasted replacement content. The transcript is JSONL: keep only entries whose `type` is `user` or `assistant` (skip entries with `isSidechain` or `isMeta` set to true), and from each entry's `message.content` take the text (a plain string, or the `text` of blocks with `type: "text"`), omitting `tool_use`, `tool_result`, thinking blocks, and other tool metadata. Write the user and assistant text in chronological order to create an in-memory or temporary text file named `chat-transcript.txt` for the upload. Do not inspect or submit unrelated session files.

Before making the write request, collect the assignment ID and verify that the transcript is available. Show the user a concise confirmation summary containing the assignment ID, submission type `online_upload`, filename `chat-transcript.txt`, and the transcript file identity/path and size. Ask for explicit confirmation. Treat confirmation as valid only for that exact transcript and assignment; if either changes, ask again.

After confirmation, call the submission API with:

```text
POST http://127.0.0.1:8787/v1/submit
Authorization: Bearer <SERVER_API_KEY>
X-Submission-Confirmation: <SUBMISSION_CONFIRMATION_PHRASE>
Content-Type: multipart/form-data
```

Send multipart fields `assignment_id`, `submission_type=online_upload`, and `file`, where `file` is the exact current-chat transcript converted to `chat-transcript.txt`. Use whatever API credentials are already available to the calling environment or API client; do not obtain them by inspecting local files, Keychain, process arguments, or server configuration. Never display credentials, the Canvas token, or full authorization headers to the user. If the transcript cannot be located or read, exceeds the API's accepted size, the API is unreachable, authentication fails, the API rejects the confirmation, or Canvas returns an error, report the error plainly and do not retry a write automatically. Do not attempt to start, stop, repair, or diagnose the service.

Do not claim success based on the HTTP request alone: report the Canvas response and identify whether Canvas accepted the submission.
