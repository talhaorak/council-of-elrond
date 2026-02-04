import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { buildConfig } from '../../config/loader.js';
import { ConsensusEngine } from '../../core/engine.js';
import type { ConsensusEvent, AgentMessage, ModeratorMessage } from '../../core/types.js';
import { writeMarkdownFile } from '../../output/markdown.js';
import { SessionManager } from '../../output/state.js';

interface TUIProps {
  options: {
    topic?: string;
    config?: string;
    depth?: string;
    agent?: string[];
    moderatorProvider?: string;
    moderatorModel?: string;
    output?: string;
    stdout?: boolean;
  };
}

interface DisplayMessage {
  type: 'agent' | 'moderator' | 'system';
  name: string;
  content: string;
  stance?: string;
  keyPoints?: string[];
}

/**
 * Main TUI App Component
 */
function App({ options }: TUIProps) {
  const { exit } = useApp();
  const [status, setStatus] = useState<'loading' | 'running' | 'complete' | 'error'>('loading');
  const [currentPhase, setCurrentPhase] = useState<string>('');
  const [currentRound, setCurrentRound] = useState<number>(0);
  const [currentSpeaker, setCurrentSpeaker] = useState<string>('');
  const [streamingContent, setStreamingContent] = useState<string>('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [error, setError] = useState<string>('');
  const [sessionId, setSessionId] = useState<string>('');

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    }
  });

  useEffect(() => {
    let cancelled = false;

    async function runDiscussion() {
      try {
        const config = await buildConfig({
          configFile: options.config,
          topic: options.topic,
          depth: options.depth ? parseInt(options.depth) : undefined,
          agents: options.agent,
          moderatorProvider: options.moderatorProvider,
          moderatorModel: options.moderatorModel,
          outputPath: options.output,
          outputStdout: options.stdout,
        });

        const engine = new ConsensusEngine(config);
        const sessionManager = new SessionManager();

        setStatus('running');

        for await (const event of engine.runStream()) {
          if (cancelled) break;
          handleEvent(event);
        }

        if (!cancelled) {
          await sessionManager.save(engine.getSession());
          setSessionId(engine.getSession().id);

          if (config.outputPath) {
            const output = {
              session: engine.getSession(),
              summary: {
                topic: config.topic,
                participantCount: config.agents.length,
                roundCount: config.depth,
                consensusReached: engine.getSession().consensusReached,
                finalConsensus: engine.getSession().finalConsensus || '',
                keyAgreements: [],
                remainingDisagreements: [],
                agentSummaries: [],
              },
              transcript: engine.getSession().messages,
            };
            await writeMarkdownFile(output, config.outputPath);
          }

          setStatus('complete');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setStatus('error');
        }
      }
    }

    function handleEvent(event: ConsensusEvent) {
      switch (event.type) {
        case 'phase_change':
          setCurrentPhase(event.phase);
          setCurrentRound(event.round);
          setMessages((prev) => [
            ...prev,
            {
              type: 'system',
              name: 'System',
              content: `── ${event.phase} (Round ${event.round}) ──`,
            },
          ]);
          break;

        case 'agent_speaking':
          setCurrentSpeaker(event.agentName);
          setStreamingContent('');
          break;

        case 'agent_message_chunk':
          setStreamingContent((prev) => prev + event.content);
          break;

        case 'agent_message_complete':
          setCurrentSpeaker('');
          setStreamingContent('');
          setMessages((prev) => [
            ...prev,
            {
              type: 'agent',
              name: event.message.agentName,
              content: event.message.content,
              stance: event.message.stance,
              keyPoints: event.message.keyPoints,
            },
          ]);
          break;

        case 'moderator_speaking':
          setCurrentSpeaker('Moderator');
          setStreamingContent('');
          break;

        case 'moderator_message_chunk':
          setStreamingContent((prev) => prev + event.content);
          break;

        case 'moderator_message_complete':
          setCurrentSpeaker('');
          setStreamingContent('');
          setMessages((prev) => [
            ...prev,
            {
              type: 'moderator',
              name: 'Moderator',
              content: event.message.content,
            },
          ]);
          break;

        case 'consensus_reached':
          setMessages((prev) => [
            ...prev,
            {
              type: 'system',
              name: 'System',
              content: '✓ Consensus Phase Complete',
            },
          ]);
          break;
      }
    }

    runDiscussion();

    return () => {
      cancelled = true;
    };
  }, [options]);

  if (status === 'loading') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan">
          <Spinner type="dots" /> Initializing discussion...
        </Text>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">✗ Error: {error}</Text>
        <Text color="gray">Press q to exit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="single" borderColor="cyan" paddingX={2} marginBottom={1}>
        <Text color="cyan" bold>
          🤖 Bot Consensus
        </Text>
        <Text> │ </Text>
        <Text color="yellow">{currentPhase}</Text>
        <Text> │ </Text>
        <Text>Round {currentRound}</Text>
        {status === 'complete' && (
          <>
            <Text> │ </Text>
            <Text color="green">✓ Complete</Text>
          </>
        )}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {messages.slice(-10).map((msg, i) => (
          <MessageDisplay key={i} message={msg} />
        ))}
      </Box>

      {currentSpeaker && (
        <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
          <Text color="blue" bold>
            <Spinner type="dots" /> {currentSpeaker}
          </Text>
          <Text wrap="wrap">{streamingContent || '...'}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        {status === 'complete' ? (
          <Box flexDirection="column">
            <Text color="green">Discussion complete!</Text>
            <Text color="gray">Session ID: {sessionId}</Text>
            <Text color="gray">Press q to exit</Text>
          </Box>
        ) : (
          <Text color="gray">Press q to quit</Text>
        )}
      </Box>
    </Box>
  );
}

function MessageDisplay({ message }: { message: DisplayMessage }) {
  if (message.type === 'system') {
    return (
      <Box marginY={1}>
        <Text color="blue" bold>
          {message.content}
        </Text>
      </Box>
    );
  }

  const color = message.type === 'moderator' ? 'yellow' : 'cyan';
  const prefix = message.type === 'moderator' ? '🎯' : '💬';

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={color} bold>
          {prefix} {message.name}
        </Text>
        {message.stance && <Text color="gray"> [{message.stance}]</Text>}
      </Box>
      <Box paddingLeft={2}>
        <Text wrap="wrap" dimColor>
          {message.content.slice(0, 200)}
          {message.content.length > 200 ? '...' : ''}
        </Text>
      </Box>
      {message.keyPoints && message.keyPoints.length > 0 && (
        <Box paddingLeft={2}>
          <Text color="gray" italic>
            Key: {message.keyPoints.slice(0, 3).join(' | ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export async function runTUI(options: TUIProps['options']): Promise<void> {
  const { waitUntilExit } = render(<App options={options} />);
  await waitUntilExit();
}

if (import.meta.main) {
  runTUI({}).catch(console.error);
}
