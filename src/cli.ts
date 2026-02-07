#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { buildConfig, generateSampleConfig, loadConfigFile } from './config/loader.js';
import { ConsensusEngine } from './core/engine.js';
import { generateMarkdown, generateCompactSummary, writeMarkdownFile, generateFilename } from './output/markdown.js';
import { SessionManager, getSessionSummary } from './output/state.js';
import { getPersonalityTemplates } from './agents/personalities/index.js';
import { checkAvailableProviders, getDefaultProvider } from './providers/index.js';
import {
  VALID_PROVIDERS,
  VALID_ARCHETYPES,
  VALID_ALGORITHMS,
  ARCHETYPE_DESCRIPTIONS,
  PROVIDER_NAMES,
  SUGGESTED_TEAMS,
} from './config/schema.js';
import { loadTeamTemplates, getTeamById } from './config/teams.js';
import { writeFile } from 'fs/promises';
import { WorkspaceManager } from './core/workspace.js';
import { logger } from './core/logger.js';

const program = new Command();

program
  .name('consensus')
  .description('Multi-agent AI consensus system')
  .version('1.0.0');

// Main run command
program
  .command('run', { isDefault: true })
  .description('Run a consensus discussion')
  .option('-t, --topic <topic>', 'Discussion topic')
  .option('-c, --config <file>', 'Configuration file (YAML or JSON)')
  .option('--team <name>', 'Use a pre-configured team template (e.g., council-of-elrond)')
  .option('-d, --depth <number>', 'Discussion depth (rounds)', '3')
  .option('--algorithm <name>', 'Discussion algorithm: sequential | parallel-sequential | six-hats | debate | delphi')
  .option('-a, --agent <spec...>', 'Agent spec: provider:model:personality or personality')
  .option('--moderator-provider <provider>', 'Moderator LLM provider')
  .option('--moderator-model <model>', 'Moderator LLM model')
  .option('-o, --output <path>', 'Output markdown file path')
  .option('--stdout', 'Output to stdout instead of file')
  .option('--continue <session-id>', 'Continue a previous session')
  .option('--tui', 'Use terminal UI mode')
  .option('--web', 'Start web UI server')
  .option('-p, --port <number>', 'Web UI port', '3000')
  .option('-w, --wizard', 'Start interactive wizard')
  .option('--workspace <path>', 'Working directory for sessions and config')
  .option('--force', 'Start new session even if there is an incomplete one')
  .option('--debug', 'Enable debug logging')
  // Limits options
  .option('--max-cost <usd>', 'Maximum cost in USD before abort')
  .option('--max-time <minutes>', 'Maximum duration in minutes')
  .option('--max-tokens <count>', 'Maximum total tokens')
  .option('--max-blockers <count>', 'Maximum unresolved blockers before abort')
  .option('--require-human', 'Pause on critical blockers and request human decision')
  .option('--human-decision <text>', 'Provide a human decision to resolve critical blockers')
  .option('--json', 'Output machine-readable JSON to stdout')
  .action(async (options) => {
    try {
      // Setup workspace
      const workspace = new WorkspaceManager(options.workspace);
      await workspace.init();
      await workspace.applyApiKeys();

      // Enable debug logging if requested
      if (options.debug) {
        logger.configure({ level: 'debug', file: true, console: true });
      }

      // Check for existing config or incomplete session
      const hasConfig = await workspace.hasConfig();
      const hasIncomplete = await workspace.hasIncompleteSession();

      if (hasIncomplete && !options.wizard && !options.web && !options.tui && !options.force && !options.continue) {
        const state = await workspace.loadCurrentState();
        if (state) {
          console.log(chalk.yellow('\n⚠ Incomplete session detected:'));
          console.log(chalk.dim(`  Topic: ${state.topic}`));
          console.log(chalk.dim(`  Phase: ${state.phase}, Round: ${state.round}/${state.totalRounds}`));
          console.log(chalk.dim(`  Last update: ${state.lastUpdate}`));
          console.log(chalk.dim('\nOptions:'));
          console.log(chalk.dim('  - Use --continue ' + state.sessionId + ' to resume'));
          console.log(chalk.dim('  - Use --force to start a new session (archives incomplete one)'));
          console.log(chalk.dim('  - Use --wizard for interactive management\n'));
          process.exit(1);
        }
      }

      // Archive incomplete session if --force is used (Bug fix #3)
      if (hasIncomplete && options.force) {
        const state = await workspace.loadCurrentState();
        if (state) {
          console.log(chalk.yellow(`\n⚠ Archiving incomplete session: ${state.sessionId}`));
          await workspace.clearCurrentState();
        }
      }

      // Wizard mode
      if (options.wizard) {
        const { runWizard } = await import('./ui/tui/wizard.js');
        await runWizard();
        return;
      }

      // TUI mode
      if (options.tui) {
        const { runTUI } = await import('./ui/tui/app.jsx');
        await runTUI(options);
        return;
      }

      // Web mode - with or without discussion
      if (options.web) {
        const { startServer } = await import('./ui/web/server.js');
        const port = parseInt(options.port);
        
        // If topic or continue is provided, run discussion with web monitoring
        if (options.topic || options.continue) {
          // Start web server in background
          console.log(chalk.blue(`\n🌐 Starting web UI at http://localhost:${port}`));
          console.log(chalk.dim('   Monitor progress in your browser while discussion runs\n'));
          
          // Start server but don't await (runs in background)
          startServer(port, options.workspace).catch(err => {
            console.error(chalk.yellow('Web server error:'), err.message);
          });
          
          // Small delay to let server start
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Continue to headless run or continue session
          if (options.continue) {
            await continueSession(options.continue, options, workspace);
            return;
          }
          // Fall through to headless run below
        } else {
          // Web-only mode (no discussion)
          await startServer(port, options.workspace);
          return;
        }
      }

      // Continue previous session
      if (options.continue) {
        await continueSession(options.continue, options, workspace);
        return;
      }

      // Standard headless run
      await runHeadless(options, workspace);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      logger.error('CLI', 'Fatal error', { error: error instanceof Error ? error.message : error });
      await logger.flush();
      logger.destroy();
      process.exit(1);
    }
  });

// Initialize config
program
  .command('init')
  .description('Create a sample configuration file')
  .option('-o, --output <file>', 'Output file', 'consensus.yaml')
  .action(async (options) => {
    const config = generateSampleConfig();
    await writeFile(options.output, config, 'utf-8');
    console.log(chalk.green(`✓ Created ${options.output}`));
    console.log(chalk.dim('Edit this file and run: consensus run -c consensus.yaml'));
  });

// List personalities
program
  .command('personalities')
  .description('List available personality templates')
  .action(async () => {
    console.log(chalk.bold('\nBuilt-in Personality Archetypes:\n'));
    
    for (const archetype of VALID_ARCHETYPES) {
      const desc = ARCHETYPE_DESCRIPTIONS[archetype];
      console.log(`  ${chalk.cyan(archetype.padEnd(16))} ${desc}`);
    }

    console.log(chalk.bold('\nSuggested Teams:\n'));
    
    for (const [key, team] of Object.entries(SUGGESTED_TEAMS)) {
      console.log(`  ${chalk.yellow(team.name)}`);
      console.log(`  ${chalk.dim(team.description)}`);
      console.log(`  Agents: ${team.archetypes.join(', ')}\n`);
    }

    console.log(chalk.dim('\nCustom personalities can be defined in config files.'));
    console.log(chalk.dim('See: consensus init'));
  });

// List providers
program
  .command('providers')
  .description('List and check available LLM providers')
  .action(async () => {
    console.log(chalk.bold('\nChecking LLM Providers...\n'));

    const results = await checkAvailableProviders();
    const defaultProvider = getDefaultProvider();

    for (const result of results) {
      const name = PROVIDER_NAMES[result.provider];
      const status = result.available
        ? chalk.green('✓ Available')
        : chalk.red('✗ Not configured');
      const isDefault = result.provider === defaultProvider ? chalk.yellow(' (default)') : '';
      
      console.log(`  ${name.padEnd(20)} ${status}${isDefault}`);
      
      if (result.error && !result.error.includes('API key')) {
        console.log(chalk.dim(`    ${result.error}`));
      }
    }

    console.log(chalk.dim('\nSet API keys via environment variables or config file.'));
    console.log(chalk.dim('See: .env.example'));
  });

// List teams
program
  .command('teams')
  .alias('list-teams')
  .description('List available team templates')
  .action(async () => {
    console.log(chalk.bold('\n🎭 Available Team Templates:\n'));

    const teams = await loadTeamTemplates();

    if (teams.length === 0) {
      console.log(chalk.dim('No team templates found in templates/teams/'));
      return;
    }

    for (const team of teams) {
      const icon = team.icon || '🤖';
      console.log(`  ${icon} ${chalk.cyan(team.name)} ${chalk.dim(`(${team.id})`)}`);
      console.log(`     ${chalk.dim(team.description.split('\n')[0])}`);
      console.log(`     ${chalk.yellow(team.agents.length)} agents\n`);
    }

    console.log(chalk.dim('Use a team: consensus run --team <id> -t "Your topic"'));
    console.log(chalk.dim('Example: consensus run --team council-of-elrond -t "Should we use microservices?"\n'));
  });

// List sessions
program
  .command('sessions')
  .description('List saved discussion sessions')
  .action(async () => {
    const manager = new SessionManager();
    const sessions = await manager.list();

    if (sessions.length === 0) {
      console.log(chalk.dim('No saved sessions found.'));
      return;
    }

    console.log(chalk.bold('\nSaved Sessions:\n'));

    for (const session of sessions) {
      const status = session.isComplete
        ? chalk.green('Complete')
        : chalk.yellow('In Progress');
      const date = session.createdAt.toLocaleDateString();
      
      console.log(`  ${chalk.cyan(session.id)}`);
      console.log(`    Topic: ${session.topic.slice(0, 50)}${session.topic.length > 50 ? '...' : ''}`);
      console.log(`    Status: ${status} | Date: ${date}`);
      console.log('');
    }

    console.log(chalk.dim('Continue a session: consensus run --continue <session-id>'));
  });

// Session details
program
  .command('session <id>')
  .description('Show details of a saved session')
  .action(async (id) => {
    const manager = new SessionManager();
    const session = await manager.load(id);

    if (!session) {
      console.error(chalk.red(`Session not found: ${id}`));
      process.exit(1);
    }

    console.log(getSessionSummary(session));
  });

/**
 * Run headless discussion
 */
async function runHeadless(options: any, workspace: WorkspaceManager) {
  if (options.algorithm && !VALID_ALGORITHMS.includes(options.algorithm)) {
    throw new Error(
      `Invalid algorithm "${options.algorithm}". Valid options: ${VALID_ALGORITHMS.join(', ')}`
    );
  }

  // Load team template if specified
  let teamTemplate = null;
  if (options.team) {
    teamTemplate = await getTeamById(options.team);
    if (!teamTemplate) {
      throw new Error(`Team template not found: ${options.team}. Use --list-teams to see available teams.`);
    }
  }

  // Build config
  const config = await buildConfig({
    configFile: options.config,
    topic: options.topic,
    depth: parseInt(options.depth),
    algorithm: options.algorithm,
    agents: options.agent,
    moderatorProvider: options.moderatorProvider,
    moderatorModel: options.moderatorModel,
    outputPath: options.output,
    outputStdout: options.stdout,
    teamTemplate,
  });

  // Add limits (prefer explicit CLI flags; otherwise fall back to team template limits if present)
  const teamLimits = teamTemplate?.limits;
  const maxCostUsd = options.maxCost !== undefined
    ? parseFloat(options.maxCost)
    : (teamLimits?.maxCostUsd ?? 5.0);

  const maxDurationMs = options.maxTime !== undefined
    ? parseFloat(options.maxTime) * 60 * 1000
    : (teamLimits?.maxDurationMs ?? (10 * 60 * 1000));

  const maxTokens = options.maxTokens !== undefined
    ? parseInt(options.maxTokens)
    : (teamLimits?.maxTokens ?? undefined);

  const maxBlockers = options.maxBlockers !== undefined
    ? parseInt(options.maxBlockers)
    : (teamLimits?.maxBlockers ?? 20);

  config.limits = {
    maxCostUsd,
    maxDurationMs,
    maxTokens,
    maxBlockers,
    maxConsecutiveDisagreements: teamLimits?.maxConsecutiveDisagreements,
    requireHumanDecision: options.requireHuman ? true : (teamLimits?.requireHumanDecision ?? false),
  };

  if (!options.json) {
    console.log(chalk.bold(`\n🎯 Topic: ${config.topic}`));
    console.log(
      chalk.dim(
        `   Depth: ${config.depth} rounds | Agents: ${config.agents.length} | Algorithm: ${config.algorithm || 'sequential'}\n`
      )
    );
  }

  // Save config to workspace
  await workspace.saveConfig({
    topic: config.topic,
    depth: config.depth,
    algorithm: config.algorithm,
    agents: config.agents.map(a => ({
      provider: a.provider,
      model: a.model,
      personality: a.personality.name,
      name: a.name,
    })),
    moderator: {
      provider: config.moderator.provider,
      model: config.moderator.model,
    },
  });

  // Create and run engine with workspace for auto-save
  const engine = new ConsensusEngine(config, undefined, workspace);
  const sessionManager = new SessionManager();

  // Progress logging (disabled in JSON mode)
  if (!options.json) {
    engine.on((event) => {
      switch (event.type) {
        case 'phase_change':
          console.log(chalk.blue(`\n── ${event.phase} (Round ${event.round}) ──\n`));
          break;
        case 'agent_speaking':
          process.stdout.write(chalk.cyan(`${event.agentName}: `));
          break;
        case 'agent_message_complete':
          console.log(chalk.dim(`[${event.message.stance}]`));
          break;
        case 'agent_skipped':
          console.log(chalk.yellow(`${event.agentName}: [SKIPPED]`));
          break;
        case 'moderator_speaking':
          process.stdout.write(chalk.yellow('Moderator: '));
          break;
        case 'moderator_message_complete':
          console.log(chalk.dim(`[${event.message.type}]`));
          break;
        case 'round_complete':
          console.log(chalk.dim(`\n── Round ${event.round} complete ──`));
          break;
      }
    });
  }

  // Run discussion
  let output = await engine.run();
  let activeEngine = engine;

  if (output.session.abortReason?.type === 'needs_human') {
    const decision = await getHumanDecision(options);
    if (decision) {
      const resumed = await ConsensusEngine.resume(activeEngine.getSession(), 1, {
        humanDecision: decision,
        resolveBlockers: 'all',
      });
      output = await resumed.run();
      activeEngine = resumed;
    }
  }

  // Save session and mark complete
  await sessionManager.save(activeEngine.getSession());
  await workspace.markCompleted(activeEngine.getSession().id);

  // Generate output
  if (options.json) {
    const jsonResult = {
      success: output.session.abortReason ? false : true,
      sessionId: activeEngine.getSession().id,
      topic: output.summary.topic,
      consensusReached: output.summary.consensusReached,
      consensus: output.summary.finalConsensus,
      keyAgreements: output.summary.keyAgreements,
      disagreements: output.summary.remainingDisagreements,
      participantCount: output.summary.participantCount,
      roundCount: output.summary.roundCount,
      interrupted: false,
      abortReason: output.session.abortReason ?? null,
    };
    console.log(JSON.stringify(jsonResult, null, 2));
    if (config.outputPath) {
      await writeMarkdownFile(output, config.outputPath);
    }
    // Clean exit — destroy logger to clear setInterval, then exit
    await logger.flush();
    logger.destroy();
    process.exit(0);
  }

  if (config.outputToStdout) {
    console.log('\n' + generateCompactSummary(output));
  }

  if (config.outputPath) {
    await writeMarkdownFile(output, config.outputPath);
    console.log(chalk.green(`\n✓ Output saved to ${config.outputPath}`));
  } else if (!config.outputToStdout) {
    // Auto-generate filename
    const filename = generateFilename(config.topic, engine.getSession().id);
    await writeMarkdownFile(output, filename);
    console.log(chalk.green(`\n✓ Output saved to ${filename}`));
  }

  console.log(chalk.dim(`Session ID: ${activeEngine.getSession().id}`));
  
  // Clean exit — destroy logger to clear setInterval, then exit
  await logger.flush();
  logger.destroy();
  process.exit(0);
}

/**
 * Continue a previous session
 */
async function continueSession(sessionId: string, options: any, workspace: WorkspaceManager) {
  if (options.algorithm && !VALID_ALGORITHMS.includes(options.algorithm)) {
    throw new Error(
      `Invalid algorithm "${options.algorithm}". Valid options: ${VALID_ALGORITHMS.join(', ')}`
    );
  }

  const manager = new SessionManager();
  const session = await manager.load(sessionId);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!options.json) {
    console.log(chalk.bold(`\n📝 Continuing session: ${sessionId}`));
    console.log(chalk.dim(`   Topic: ${session.config.topic}`));
    console.log(chalk.dim(`   Previous rounds: ${session.currentRound}\n`));
  }

  if (options.algorithm) {
    session.config.algorithm = options.algorithm;
  }

  const additionalRounds = parseInt(options.depth) || 2;
  const engine = await ConsensusEngine.resume(session, additionalRounds, {
    humanDecision: options.humanDecision,
    resolveBlockers: options.humanDecision ? 'all' : undefined,
  });

  // Same progress logging as headless (disabled in JSON mode)
  if (!options.json) {
    engine.on((event) => {
      switch (event.type) {
        case 'phase_change':
          console.log(chalk.blue(`\n── ${event.phase} (Round ${event.round}) ──\n`));
          break;
        case 'agent_speaking':
          process.stdout.write(chalk.cyan(`${event.agentName}: `));
          break;
        case 'agent_message_complete':
          console.log(chalk.dim(`[${event.message.stance}]`));
          break;
        case 'agent_skipped':
          console.log(chalk.yellow(`${event.agentName}: [SKIPPED]`));
          break;
        case 'moderator_speaking':
          process.stdout.write(chalk.yellow('Moderator: '));
          break;
        case 'moderator_message_complete':
          console.log(chalk.dim(`[${event.message.type}]`));
          break;
      }
    });
  }

  let output = await engine.run();
  let activeEngine = engine;

  if (output.session.abortReason?.type === 'needs_human') {
    const decision = await getHumanDecision(options);
    if (decision) {
      const resumed = await ConsensusEngine.resume(activeEngine.getSession(), 1, {
        humanDecision: decision,
        resolveBlockers: 'all',
      });
      output = await resumed.run();
      activeEngine = resumed;
    }
  }

  // Save updated session
  await manager.save(activeEngine.getSession());
  await workspace.markCompleted(activeEngine.getSession().id);

  // Output
  if (options.json) {
    const jsonResult = {
      success: output.session.abortReason ? false : true,
      sessionId: activeEngine.getSession().id,
      topic: output.summary.topic,
      consensusReached: output.summary.consensusReached,
      consensus: output.summary.finalConsensus,
      keyAgreements: output.summary.keyAgreements,
      disagreements: output.summary.remainingDisagreements,
      participantCount: output.summary.participantCount,
      roundCount: output.summary.roundCount,
      interrupted: false,
      abortReason: output.session.abortReason ?? null,
    };
    console.log(JSON.stringify(jsonResult, null, 2));
    if (options.output) {
      await writeMarkdownFile(output, options.output);
    }
    // Clean exit
    await logger.flush();
    logger.destroy();
    process.exit(0);
  }

  const filename = options.output || generateFilename(session.config.topic, activeEngine.getSession().id);
  await writeMarkdownFile(output, filename);
  console.log(chalk.green(`\n✓ Output saved to ${filename}`));
  
  // Clean exit
  await logger.flush();
  logger.destroy();
  process.exit(0);
}

async function getHumanDecision(options: any): Promise<string | null> {
  if (options.humanDecision) {
    return String(options.humanDecision);
  }

  if (!process.stdin.isTTY) {
    return null;
  }

  const { createInterface } = await import('readline');
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question('\nHuman decision required. Provide resolution text (or press Enter to skip):\n> ', (response) => {
      resolve(response.trim());
    });
  });

  rl.close();
  return answer.length > 0 ? answer : null;
}

// Parse and run
program.parse();
