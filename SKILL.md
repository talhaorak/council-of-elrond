---
name: bot-consensus
description: Run multi-agent AI consensus discussions to analyze topics from multiple perspectives. Use when you need balanced analysis, want to explore different viewpoints on a decision, or need to reach a well-reasoned conclusion on complex topics. Agents with distinct personalities (skeptic, optimist, pragmatist, innovator, etc.) discuss and debate to produce actionable consensus.
license: MIT
compatibility: Requires Bun runtime and at least one LLM provider (LM Studio local by default, or OpenAI/Anthropic/Google API keys)
metadata:
  author: Talha Orak
  version: "1.0.0"
  category: analysis
  tags: consensus ai-agents discussion decision-making analysis council-of-elrond
---

# Council of Elrond (Bot Consensus) Skill

Run structured multi-agent discussions to analyze topics from multiple perspectives and reach consensus.

> *"Nine companions... so be it. You shall be the Fellowship of the Ring."* — But with LLMs!

Defaults are permissive for headless runs: `requireHumanDecision` is off and `maxBlockers` defaults to 20.

## When to Use This Skill

Use this skill when you need to:
- **Analyze complex decisions** from multiple viewpoints
- **Explore pros and cons** of different approaches
- **Get balanced analysis** rather than a single perspective
- **Stress-test ideas** before committing to them
- **Reach well-reasoned conclusions** on ambiguous topics
- **Document decision rationale** with supporting arguments

## Quick Usage

### Using Pre-configured Teams (Recommended)

```bash
# Council of Elrond - balanced team inspired by Tolkien
consensus run --team council-of-elrond --topic "Critical architecture decision"

# Free Council - zero-cost with free OpenRouter models
consensus run --team free-council --topic "Quick analysis needed"

# Pro Council - elite team for high-stakes decisions
consensus run --team pro-council --topic "Major business decision"

# Local Council - runs on local LLMs (LM Studio/Ollama)
consensus run --team local-council --topic "Private discussion"

# List available teams
consensus --list-teams
```

### Simple 2-Agent Discussion

```bash
cd /path/to/bot-consensus
bun run src/cli.ts run \
  --topic "Should we migrate from REST to GraphQL?" \
  --agent skeptic \
  --agent optimist \
  --depth 2 \
  --stdout
```

### Balanced 4-Agent Team

```bash
bun run src/cli.ts run \
  --topic "Best database choice for our high-write workload" \
  --agent pragmatist \
  --agent innovator \
  --agent skeptic \
  --agent analyst \
  --depth 3 \
  --output decision.md
```

### Programmatic Usage (for AI agents)

```typescript
import { runConsensusJSON } from 'bot-consensus';

const result = await runConsensusJSON({
  topic: "Your analysis topic here",
  agents: [
    { personality: 'skeptic' },
    { personality: 'pragmatist' },
  ],
  depth: 2,
});

// Returns structured result:
// {
//   success: true,
//   consensusReached: true,
//   consensus: "The balanced conclusion...",
//   keyAgreements: ["Point 1", "Point 2"],
//   disagreements: ["Remaining concern"],
// }
```

## Available Personalities

| Personality | Role | Best For |
|-------------|------|----------|
| `skeptic` | Questions assumptions, demands evidence | Testing rigor of ideas |
| `optimist` | Sees potential, focuses on solutions | Identifying opportunities |
| `pessimist` | Identifies risks and failure modes | Risk assessment |
| `pragmatist` | Focuses on practical implementation | Grounding in reality |
| `innovator` | Proposes creative solutions | Brainstorming alternatives |
| `devils-advocate` | Argues opposite positions | Stress-testing consensus |
| `analyst` | Systematic, data-driven analysis | Technical decisions |
| `mediator` | Bridges differences | Resolving conflicts |

## Pre-configured Team Templates

Use `--team <name>` to quickly start with a balanced, pre-configured team:

### List Available Teams
```bash
bun run src/cli.ts teams
# Or
bun run src/cli.ts list-teams
```

### Council of Elrond (7 agents, OpenRouter)
```bash
bun run src/cli.ts run --team council-of-elrond --topic "Your critical decision"
```
Epic fantasy-themed team with 7 distinct perspectives. Each agent embodies a Fellowship character.

### Free Council (4 agents, $0 cost)
```bash
bun run src/cli.ts run --team free-council --topic "Your topic"
```
Uses free OpenRouter models. Perfect for testing and learning without API costs.

### Pro Council (6 agents, premium models)
```bash
bun run src/cli.ts run --team pro-council --topic "Critical business decision"
```
Elite team with the most powerful reasoning models (Claude Opus, GPT-5.2 Pro, etc).

### Local Council (4 agents, fully local)
```bash
bun run src/cli.ts run --team local-council --topic "Private analysis"
```
Runs entirely on your local hardware (LM Studio/Ollama). Complete privacy, zero API costs.

## Recommended Team Compositions

### For Technical Decisions
```
--agent pragmatist --agent innovator --agent skeptic --agent analyst
# Or use a template:
--team council-of-elrond
```

### For Risk Assessment
```
--agent skeptic --agent pessimist --agent analyst --agent pragmatist
```

### For Quick Sanity Check
```
--agent optimist --agent skeptic
```

### For Brainstorming
```
--agent innovator --agent optimist --agent devils-advocate --agent mediator
```

## Output Format

The tool produces:

1. **Consensus Statement**: The final agreed-upon conclusion
2. **Key Agreements**: Points all agents agreed on
3. **Disagreements**: Remaining unresolved concerns
4. **Full Transcript**: Complete discussion (in markdown output)
5. **Abort Reason (if any)**: When limits are hit or a human decision is required

### JSON Output Structure

```json
{
  "success": true,
  "sessionId": "abc123",
  "consensusReached": true,
  "consensus": "After thorough discussion, the team agrees that...",
  "keyAgreements": [
    "Point that all agents agreed on",
    "Another shared conclusion"
  ],
  "disagreements": [
    "Area where opinions differ"
  ],
  "participantCount": 4,
  "roundCount": 3
}
```

Note: CLI `--json` output also includes `abortReason` when a run stops due to limits or requires human decision.

### Headless CLI (for AI agents)

```bash
bun run src/cli.ts run --json \
  --topic "Should we use event sourcing?" \
  --agent skeptic --agent pragmatist
```

### Limits & Human Decision (optional)

```bash
# Pause on critical blockers and provide a decision to continue
bun run src/cli.ts run \
  --topic "Proactive LLM design" \
  --agent skeptic --agent pragmatist \
  --require-human \
  --human-decision "Allow proactive suggestions only in low-risk domains with explicit consent."
```

## Discussion Depth Guide

| Depth | Rounds | Duration | Best For |
|-------|--------|----------|----------|
| 2 | Quick | ~2 min | Simple yes/no decisions |
| 3 | Standard | ~5 min | Most decisions |
| 4 | Thorough | ~8 min | Important decisions |
| 5 | Deep | ~12 min | Critical/complex topics |

## Example Scenarios

### Architecture Decision
```bash
bun run src/cli.ts run \
  --topic "Should we use microservices or a modular monolith for our new e-commerce platform?" \
  --agent pragmatist \
  --agent innovator \
  --agent skeptic \
  --agent analyst \
  --depth 3
```

### Technology Selection
```bash
bun run src/cli.ts run \
  --topic "PostgreSQL vs MongoDB for our user activity logging system with 10M daily events" \
  --agent analyst \
  --agent pragmatist \
  --agent pessimist \
  --depth 3
```

### Process Decision
```bash
bun run src/cli.ts run \
  --topic "Should our team adopt trunk-based development or continue with GitFlow?" \
  --agent skeptic \
  --agent optimist \
  --agent pragmatist \
  --depth 2
```

## Interrupting Discussions

During interactive mode:
- Press `s` to soft interrupt (wrap up gracefully)
- Press `q` or `Ctrl+C` to stop immediately
- Press `v` to toggle verbose/quiet output

## Session Continuation

```bash
# List previous sessions
bun run src/cli.ts sessions

# Continue a discussion with 2 more rounds
bun run src/cli.ts run --continue <session-id> --depth 2
```

## Error Handling

If the discussion fails:
1. Check that your LLM provider is running (LM Studio default: http://localhost:1234)
2. Verify API keys are set for cloud providers
3. Ensure at least 2 agents are specified
4. Check the topic is specific enough for meaningful discussion
5. If `requireHumanDecision` is enabled, provide a decision in the Web UI or use `--human-decision`

## Integration Tips

### For Coding Assistants
When a user asks "should I use X or Y?", run a quick consensus:
```typescript
const result = await quickConsensus(`${userQuestion} - considering ${context}`);
return `Based on multi-perspective analysis: ${result.consensus}`;
```

### For Decision Documentation
```typescript
const result = await runConsensus({
  topic: decisionTopic,
  agents: [
    { personality: 'pragmatist' },
    { personality: 'skeptic' },
    { personality: 'analyst' },
  ],
  depth: 3,
  outputPath: `decisions/${slug}-${date}.md`,
});
```

### For Code Review Enhancement
```typescript
const result = await runConsensusJSON({
  topic: `Review this architectural approach: ${codeDescription}`,
  agents: [
    { personality: 'skeptic' },
    { personality: 'pragmatist' },
  ],
  depth: 2,
});
```
