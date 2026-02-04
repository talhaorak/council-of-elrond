#!/usr/bin/env bun
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
  ARCHETYPE_DESCRIPTIONS,
  PROVIDER_NAMES,
  SUGGESTED_TEAMS,
} from './config/schema.js';
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
  .option('-d, --depth <number>', 'Discussion depth (rounds)', '3')
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
  .option('--debug', 'Enable debug logging')
  // Limits options
  .option('--max-cost <usd>', 'Maximum cost in USD before abort', '5.0')
  .option('--max-time <minutes>', 'Maximum duration in minutes', '10')
  .option('--max-tokens <count>', 'Maximum total tokens')
  .option('--max-blockers <count>', 'Maximum unresolved blockers before abort', '5')
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

      if (hasIncomplete && !options.wizard && !options.web && !options.tui) {
        const state = await workspace.loadCurrentState();
        if (state) {
          console.log(chalk.yellow('\n⚠ Incomplete session detected:'));
          console.log(chalk.dim(`  Topic: ${state.topic}`));
          console.log(chalk.dim(`  Phase: ${state.phase}, Round: ${state.round}/${state.totalRounds}`));
          console.log(chalk.dim(`  Last update: ${state.lastUpdate}`));
          console.log(chalk.dim('\nUse --wizard to resume or clear, or --continue <session-id>\n'));
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

      // Web mode
      if (options.web) {
        const { startServer } = await import('./ui/web/server.js');
        await startServer(parseInt(options.port), options.workspace);
        return;
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
  // Build config
  const config = await buildConfig({
    configFile: options.config,
    topic: options.topic,
    depth: parseInt(options.depth),
    agents: options.agent,
    moderatorProvider: options.moderatorProvider,
    moderatorModel: options.moderatorModel,
    outputPath: options.output,
    outputStdout: options.stdout,
  });

  // Add limits from CLI options
  config.limits = {
    maxCostUsd: parseFloat(options.maxCost) || 5.0,
    maxDurationMs: (parseFloat(options.maxTime) || 10) * 60 * 1000,
    maxTokens: options.maxTokens ? parseInt(options.maxTokens) : undefined,
    maxBlockers: parseInt(options.maxBlockers) || 5,
  };

  console.log(chalk.bold(`\n🎯 Topic: ${config.topic}`));
  console.log(chalk.dim(`   Depth: ${config.depth} rounds | Agents: ${config.agents.length}\n`));

  // Save config to workspace
  await workspace.saveConfig({
    topic: config.topic,
    depth: config.depth,
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

  // Progress logging
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

  // Run discussion
  const output = await engine.run();

  // Save session and mark complete
  await sessionManager.save(engine.getSession());
  await workspace.markCompleted(engine.getSession().id);

  // Generate output
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

  console.log(chalk.dim(`Session ID: ${engine.getSession().id}`));
}

/**
 * Continue a previous session
 */
async function continueSession(sessionId: string, options: any, workspace: WorkspaceManager) {
  const manager = new SessionManager();
  const session = await manager.load(sessionId);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  console.log(chalk.bold(`\n📝 Continuing session: ${sessionId}`));
  console.log(chalk.dim(`   Topic: ${session.config.topic}`));
  console.log(chalk.dim(`   Previous rounds: ${session.currentRound}\n`));

  const additionalRounds = parseInt(options.depth) || 2;
  const engine = await ConsensusEngine.resume(session, additionalRounds);

  // Same progress logging as headless
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

  const output = await engine.run();

  // Save updated session
  await manager.save(engine.getSession());
  await workspace.markCompleted(engine.getSession().id);

  // Output
  const filename = options.output || generateFilename(session.config.topic, engine.getSession().id);
  await writeMarkdownFile(output, filename);
  console.log(chalk.green(`\n✓ Output saved to ${filename}`));
}

// Parse and run
program.parse();
