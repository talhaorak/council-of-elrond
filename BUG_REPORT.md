# Bug Report - Council of Elrond (bot-consensus)

## Issues Found During Testing (2026-02-04)

### Bug 1: Session Not Persisted to File
**Severity:** High
**Description:** When a session is interrupted or times out, the session state exists in `.consensus/current-state.json` but no corresponding file is created in `.consensus/<sessionId>.json`. This makes `--continue <sessionId>` fail with "Session not found".

**Steps to Reproduce:**
1. Start a council run that takes a long time
2. Let it timeout or interrupt it
3. Check `.consensus/current-state.json` - sessionId exists (e.g., `TNfpAOHBeYIAkJyaQzfuG`)
4. Try `--continue TNfpAOHBeYIAkJyaQzfuG` - fails with "Session not found"

**Expected:** Session should be saved to `.consensus/<sessionId>.json` periodically, not just at completion.

**Fix Location:** `src/config/workspace.ts` - add periodic session persistence (every round or every N messages)

---

### Bug 2: Dollar Signs Stripped from Topic
**Severity:** Medium
**Description:** When passing a topic with `$` signs (e.g., "$50 budget"), the dollar amounts are stripped or interpreted as shell variables, resulting in topics like " budget" instead of "$50 budget".

**Steps to Reproduce:**
```bash
bun run src/cli.ts run --topic "How to turn $50 into $5000" ...
# Topic becomes: "How to turn  into "
```

**Expected:** Dollar signs should be preserved in the topic string.

**Fix Location:** `src/cli.ts` - ensure proper string escaping/quoting, or document that users need to escape `$` as `\$`

---

### Bug 3: Incomplete Session Blocks New Runs
**Severity:** Medium  
**Description:** When there's an incomplete session in `current-state.json`, starting a new session with `--topic` shows a warning and sometimes fails or requires extra handling.

**Expected:** New sessions with explicit `--topic` should start cleanly, optionally archiving the incomplete session.

**Fix Location:** `src/cli.ts` - add `--force` flag or auto-archive incomplete sessions when starting fresh

---

### Bug 4: SUGGESTED_TEAMS Not Usable via --team
**Severity:** Low
**Description:** The hardcoded `SUGGESTED_TEAMS` (balanced, creative, critical, minimal, comprehensive) in `src/config/schema.ts` cannot be used via `--team` flag - only YAML templates in `templates/teams/` work.

**Expected:** Either expose SUGGESTED_TEAMS via --team or create YAML templates for them.

**Fix:** Create `templates/teams/comprehensive.yaml` matching the SUGGESTED_TEAMS.comprehensive config.

---

## Testing Requirements

1. Write unit tests for session persistence
2. Test topic parsing with special characters ($, quotes, etc.)
3. Test --continue with interrupted sessions
4. Verify all SUGGESTED_TEAMS have corresponding YAML templates

## After Fixes

1. Run `bun test` to ensure all tests pass
2. Bump version in package.json (patch version)
3. Commit with message: "fix: session persistence, topic escaping, incomplete session handling"
4. Merge to master and push
5. Create a short summary of changes
