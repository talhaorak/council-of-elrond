import inquirer from 'inquirer';
import chalk from 'chalk';
import { buildConfig } from '../../config/loader.js';
import {
  detectProviders,
  loadProvidersConfig,
  saveProvidersConfig,
  updateProviderKey,
  getProviderDisplayName,
  getSourceDisplayText,
  getConfiguredProviders,
  type ProvidersConfig,
  type ProviderCredentials,
} from '../../config/providers.js';
import { ConsensusEngine } from '../../core/engine.js';
import { createInterruptController } from '../../core/interrupts.js';
import { generateCompactSummary, writeMarkdownFile } from '../../output/markdown.js';
import { SessionManager } from '../../output/state.js';
import { WorkspaceManager, type WorkspaceConfig, type CurrentState } from '../../core/workspace.js';
import {
  VALID_ARCHETYPES,
  ARCHETYPE_DESCRIPTIONS,
  SUGGESTED_TEAMS,
} from '../../config/schema.js';
import type { Provider, PersonalityArchetype } from '../../core/types.js';

interface AgentConfig {
  provider: Provider;
  model: string;
  personality: string;
  name?: string;
}

/**
 * Interactive wizard for setting up a consensus discussion
 */
export async function runWizard(): Promise<void> {
  console.log(chalk.bold.cyan('\n🤖 Bot Consensus - Interactive Setup Wizard\n'));
  console.log(chalk.dim('This wizard will help you configure a multi-agent discussion.\n'));

  // Initialize workspace
  const workspace = new WorkspaceManager();
  await workspace.init();
  await workspace.applyApiKeys();

  // Check for existing config or incomplete session
  const existingConfig = await workspace.loadConfig();
  const incompleteState = await workspace.hasIncompleteSession() ? await workspace.loadCurrentState() : null;

  // Handle incomplete session
  if (incompleteState && !incompleteState.completed) {
    console.log(chalk.yellow('⚠ Incomplete session detected:\n'));
    console.log(chalk.dim(`  Topic: ${incompleteState.topic}`));
    console.log(chalk.dim(`  Phase: ${incompleteState.phase}, Round ${incompleteState.round}/${incompleteState.totalRounds}`));
    console.log(chalk.dim(`  Messages: ${incompleteState.messages.length}`));
    console.log(chalk.dim(`  Last update: ${incompleteState.lastUpdate}\n`));

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: '▶ Resume this session', value: 'resume' },
          { name: '🗑 Clear and start fresh', value: 'clear' },
          { name: '← Exit', value: 'exit' },
        ],
      },
    ]);

    if (action === 'exit') return;
    if (action === 'resume') {
      console.log(chalk.yellow('\nResuming session... (Use --continue with the session ID for full resume)\n'));
      // For now, continue with new session but keep the topic
    }
    if (action === 'clear') {
      await workspace.clearCurrentState();
      console.log(chalk.green('✓ Cleared incomplete session\n'));
    }
  }

  // Handle existing config
  let useExistingConfig = false;
  if (existingConfig && existingConfig.topic) {
    console.log(chalk.cyan('📁 Existing configuration found:\n'));
    console.log(chalk.dim(`  Topic: ${existingConfig.topic}`));
    if (existingConfig.agents) {
      console.log(chalk.dim(`  Agents: ${existingConfig.agents.map(a => a.personality).join(', ')}`));
    }
    console.log(chalk.dim(`  Depth: ${existingConfig.depth || 3} rounds`));
    console.log(chalk.dim(`  Last modified: ${existingConfig.lastModified || 'unknown'}\n`));

    const { useConfig } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useConfig',
        message: 'Use this configuration?',
        default: true,
      },
    ]);

    useExistingConfig = useConfig;
  }

  // Step 1: Provider Configuration
  const providersConfig = await configureProviders();
  
  const configuredProviders = getConfiguredProviders(providersConfig);
  if (configuredProviders.length === 0) {
    console.log(chalk.red('\n⚠ No LLM providers are configured!'));
    console.log(chalk.dim('Please configure at least one provider to continue.\n'));
    return;
  }

  // Step 2: Topic (use existing or ask)
  let topic: string;
  if (useExistingConfig && existingConfig?.topic) {
    topic = existingConfig.topic;
    console.log(chalk.dim(`\nUsing existing topic: ${topic}\n`));
  } else {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'topic',
        message: 'What topic should the agents discuss?',
        validate: (input) => input.length > 10 || 'Topic should be at least 10 characters',
        default: existingConfig?.topic || 'The most feasible and performant REST API architecture for Go applications',
      },
    ]);
    topic = answer.topic;
  }

  // Step 3: Discussion depth
  const { depth } = await inquirer.prompt([
    {
      type: 'list',
      name: 'depth',
      message: 'How many discussion rounds?',
      choices: [
        { name: '2 rounds - Quick discussion', value: 2 },
        { name: '3 rounds - Standard (recommended)', value: 3 },
        { name: '4 rounds - Thorough', value: 4 },
        { name: '5 rounds - Deep dive', value: 5 },
      ],
      default: 1,
    },
  ]);

  // Step 4: Agent Configuration
  const agents = await configureAgents(providersConfig);

  // Step 5: Moderator Configuration
  const moderator = await configureModerator(providersConfig, agents);

  // Step 6: Output configuration
  const { outputChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'outputChoice',
      message: 'How should the results be output?',
      choices: [
        { name: '📄 Save to markdown file', value: 'file' },
        { name: '📺 Print to console', value: 'stdout' },
        { name: '📄 + 📺 Both', value: 'both' },
      ],
      default: 'both',
    },
  ]);

  let outputPath: string | undefined;
  if (outputChoice === 'file' || outputChoice === 'both') {
    const { filename } = await inquirer.prompt([
      {
        type: 'input',
        name: 'filename',
        message: 'Output filename:',
        default: 'consensus-output.md',
      },
    ]);
    outputPath = filename;
  }

  // Summary before running
  console.log(chalk.bold.cyan('\n📋 Configuration Summary\n'));
  console.log(`  ${chalk.bold('Topic:')} ${topic}`);
  console.log(`  ${chalk.bold('Depth:')} ${depth} rounds`);
  console.log(`  ${chalk.bold('Agents:')} ${agents.length}`);
  for (const agent of agents) {
    const providerName = getProviderDisplayName(agent.provider);
    console.log(`    - ${chalk.cyan(agent.personality)} (${providerName}: ${agent.model})`);
  }
  console.log(`  ${chalk.bold('Moderator:')} ${getProviderDisplayName(moderator.provider)}: ${moderator.model}`);
  console.log(`  ${chalk.bold('Output:')} ${outputPath || 'stdout'}`);
  console.log('');

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Start the discussion?',
      default: true,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('\nDiscussion cancelled.'));
    return;
  }

  // Save provider config for next time
  await saveProvidersConfig(providersConfig);

  // Build and run
  await runDiscussion({
    topic,
    depth,
    agents,
    moderator,
    outputPath,
    outputToStdout: outputChoice === 'stdout' || outputChoice === 'both',
    providersConfig,
  });
}

/**
 * Configure LLM providers
 */
async function configureProviders(): Promise<ProvidersConfig> {
  console.log(chalk.bold('\n🔧 Step 1: LLM Provider Configuration\n'));
  console.log(chalk.dim('Detecting available providers...\n'));

  let config = await loadProvidersConfig();

  // Display current status
  displayProviderStatus(config);

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: '✓ Continue with current configuration', value: 'continue' },
        { name: '🔑 Add/Update API keys', value: 'keys' },
        { name: '🔄 Re-detect providers', value: 'detect' },
        { name: '⚙️  Configure local provider URLs', value: 'urls' },
      ],
    },
  ]);

  if (action === 'detect') {
    console.log(chalk.dim('\nRe-detecting providers...\n'));
    config = await detectProviders();
    displayProviderStatus(config);
    return configureProviders(); // Recurse to show options again
  }

  if (action === 'keys') {
    config = await configureApiKeys(config);
    displayProviderStatus(config);
    return configureProviders();
  }

  if (action === 'urls') {
    config = await configureLocalUrls(config);
    displayProviderStatus(config);
    return configureProviders();
  }

  return config;
}

/**
 * Display provider status
 */
function displayProviderStatus(config: ProvidersConfig): void {
  console.log(chalk.bold('  Provider Status:'));
  
  const providers: Provider[] = ['openai', 'anthropic', 'google', 'ollama', 'lmstudio'];
  
  for (const provider of providers) {
    const creds = config.providers[provider];
    const name = getProviderDisplayName(provider).padEnd(22);
    const status = creds.isConfigured
      ? chalk.green('✓ Configured')
      : chalk.red('✗ Not configured');
    const source = creds.source ? chalk.dim(` (${getSourceDisplayText(creds.source)})`) : '';
    const isDefault = config.defaultProvider === provider ? chalk.yellow(' [default]') : '';
    
    console.log(`    ${name} ${status}${source}${isDefault}`);
    
    if (creds.isConfigured && creds.models.length > 0) {
      console.log(chalk.dim(`                          Models: ${creds.models.slice(0, 3).join(', ')}${creds.models.length > 3 ? '...' : ''}`));
    }
  }
  console.log('');
}

/**
 * Configure API keys
 */
async function configureApiKeys(config: ProvidersConfig): Promise<ProvidersConfig> {
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Which provider do you want to configure?',
      choices: [
        { name: 'OpenAI (GPT-4, etc.)', value: 'openai' },
        { name: 'Anthropic (Claude)', value: 'anthropic' },
        { name: 'Google (Gemini)', value: 'google' },
        { name: 'OpenRouter (multiple models)', value: 'openrouter' },
        { name: '← Back', value: 'back' },
      ],
    },
  ]);

  if (provider === 'back') return config;

  const currentKey = config.providers[provider as Provider].apiKey;
  const maskedKey = currentKey 
    ? `${currentKey.slice(0, 7)}...${currentKey.slice(-4)}` 
    : 'not set';

  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: `Enter API key for ${getProviderDisplayName(provider as Provider)} (current: ${maskedKey}):`,
      mask: '*',
    },
  ]);

  if (apiKey && apiKey.length > 0) {
    return updateProviderKey(config, provider as Provider, apiKey);
  }

  return config;
}

/**
 * Configure local provider URLs
 */
async function configureLocalUrls(config: ProvidersConfig): Promise<ProvidersConfig> {
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Which local provider do you want to configure?',
      choices: [
        { 
          name: `Ollama (current: ${config.providers.ollama.baseUrl})`, 
          value: 'ollama' 
        },
        { 
          name: `LM Studio (current: ${config.providers.lmstudio.baseUrl})`, 
          value: 'lmstudio' 
        },
        { name: '← Back', value: 'back' },
      ],
    },
  ]);

  if (provider === 'back') return config;

  const currentUrl = config.providers[provider as Provider].baseUrl;

  const { baseUrl } = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: `Enter base URL for ${getProviderDisplayName(provider as Provider)}:`,
      default: currentUrl,
    },
  ]);

  if (baseUrl) {
    config.providers[provider as Provider].baseUrl = baseUrl;
    
    // Re-check availability
    console.log(chalk.dim('\nChecking connection...\n'));
    const newConfig = await detectProviders();
    config.providers[provider as Provider].isConfigured = newConfig.providers[provider as Provider].isConfigured;
    config.providers[provider as Provider].models = newConfig.providers[provider as Provider].models;
  }

  return config;
}

/**
 * Configure agents with per-agent provider/model selection
 */
async function configureAgents(providersConfig: ProvidersConfig): Promise<AgentConfig[]> {
  console.log(chalk.bold('\n👥 Step 2: Agent Configuration\n'));

  const { teamChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'teamChoice',
      message: 'How would you like to configure agents?',
      choices: [
        { name: '🎯 Use a suggested team (same provider for all)', value: 'suggested' },
        { name: '🔧 Custom agents (choose provider/model per agent)', value: 'custom' },
        { name: '⚡ Quick setup (2 agents: optimist vs skeptic)', value: 'quick' },
      ],
    },
  ]);

  const configuredProviders = getConfiguredProviders(providersConfig);

  if (teamChoice === 'suggested') {
    return configureSuggestedTeam(providersConfig, configuredProviders);
  } else if (teamChoice === 'quick') {
    return configureQuickTeam(providersConfig, configuredProviders);
  } else {
    return configureCustomAgents(providersConfig, configuredProviders);
  }
}

/**
 * Configure a suggested team
 */
async function configureSuggestedTeam(
  config: ProvidersConfig,
  configuredProviders: ProviderCredentials[]
): Promise<AgentConfig[]> {
  const { team } = await inquirer.prompt([
    {
      type: 'list',
      name: 'team',
      message: 'Select a team:',
      choices: Object.entries(SUGGESTED_TEAMS).map(([key, team]) => ({
        name: `${team.name} - ${team.description} (${team.archetypes.length} agents)`,
        value: key,
      })),
    },
  ]);

  const selectedTeam = SUGGESTED_TEAMS[team as keyof typeof SUGGESTED_TEAMS];

  // Select provider and model for the whole team
  const { provider, model } = await selectProviderAndModel(
    configuredProviders,
    `Select provider for all ${selectedTeam.archetypes.length} agents:`
  );

  return selectedTeam.archetypes.map((personality) => ({
    provider,
    model,
    personality,
  }));
}

/**
 * Configure quick 2-agent team
 */
async function configureQuickTeam(
  config: ProvidersConfig,
  configuredProviders: ProviderCredentials[]
): Promise<AgentConfig[]> {
  const { provider, model } = await selectProviderAndModel(
    configuredProviders,
    'Select provider for both agents:'
  );

  return [
    { provider, model, personality: 'optimist' },
    { provider, model, personality: 'skeptic' },
  ];
}

/**
 * Configure custom agents with individual provider/model selection
 */
async function configureCustomAgents(
  config: ProvidersConfig,
  configuredProviders: ProviderCredentials[]
): Promise<AgentConfig[]> {
  const agents: AgentConfig[] = [];

  console.log(chalk.dim('\nAdd at least 2 agents. Each can use a different provider/model.\n'));

  // Ask if they want same provider for all or different
  const { sameProvider } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'sameProvider',
      message: 'Use the same provider/model for all agents?',
      default: true,
    },
  ]);

  let defaultProvider: Provider | undefined;
  let defaultModel: string | undefined;

  if (sameProvider) {
    const selection = await selectProviderAndModel(configuredProviders, 'Select provider for all agents:');
    defaultProvider = selection.provider;
    defaultModel = selection.model;
  }

  let addMore = true;
  while (addMore) {
    console.log(chalk.cyan(`\n--- Agent ${agents.length + 1} ---\n`));

    // Select personality
    const { personality } = await inquirer.prompt([
      {
        type: 'list',
        name: 'personality',
        message: 'Select personality:',
        choices: VALID_ARCHETYPES.map((a) => ({
          name: `${a} - ${ARCHETYPE_DESCRIPTIONS[a]}`,
          value: a,
        })),
      },
    ]);

    // Select provider/model if not using same for all
    let provider = defaultProvider;
    let model = defaultModel;

    if (!sameProvider) {
      const selection = await selectProviderAndModel(
        configuredProviders,
        `Select provider for ${personality}:`
      );
      provider = selection.provider;
      model = selection.model;
    }

    // Optional custom name
    const { customName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customName',
        message: 'Custom name (optional, press Enter to skip):',
        default: '',
      },
    ]);

    agents.push({
      provider: provider!,
      model: model!,
      personality,
      name: customName || undefined,
    });

    const providerName = getProviderDisplayName(provider!);
    console.log(chalk.green(`\n✓ Added: ${customName || personality} (${providerName}: ${model})`));

    if (agents.length >= 2) {
      const { continueAdding } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAdding',
          message: `Add another agent? (Current: ${agents.length})`,
          default: agents.length < 4,
        },
      ]);
      addMore = continueAdding;
    }
  }

  return agents;
}

/**
 * Select provider and model
 */
async function selectProviderAndModel(
  configuredProviders: ProviderCredentials[],
  message: string
): Promise<{ provider: Provider; model: string }> {
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message,
      choices: configuredProviders.map((p) => ({
        name: `${getProviderDisplayName(p.provider)} (${p.models.length} models)`,
        value: p.provider,
      })),
    },
  ]);

  const providerConfig = configuredProviders.find((p) => p.provider === provider)!;

  const { model } = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Select model:',
      choices: [
        ...providerConfig.models.map((m) => ({
          name: m === providerConfig.defaultModel ? `${m} (default)` : m,
          value: m,
        })),
        { name: '✏️  Enter custom model name', value: '__custom__' },
      ],
      default: providerConfig.defaultModel,
    },
  ]);

  if (model === '__custom__') {
    const { customModel } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customModel',
        message: 'Enter model name:',
        default: providerConfig.defaultModel,
      },
    ]);
    return { provider, model: customModel };
  }

  return { provider, model };
}

/**
 * Configure moderator
 */
async function configureModerator(
  providersConfig: ProvidersConfig,
  agents: AgentConfig[]
): Promise<{ provider: Provider; model: string }> {
  console.log(chalk.bold('\n🎯 Step 3: Moderator Configuration\n'));

  // Default to first agent's provider/model
  const defaultProvider = agents[0].provider;
  const defaultModel = agents[0].model;

  const { useSame } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useSame',
      message: `Use same as first agent? (${getProviderDisplayName(defaultProvider)}: ${defaultModel})`,
      default: true,
    },
  ]);

  if (useSame) {
    return { provider: defaultProvider, model: defaultModel };
  }

  return selectProviderAndModel(
    getConfiguredProviders(providersConfig),
    'Select provider for moderator:'
  );
}

/**
 * Run the discussion with wizard config
 */
async function runDiscussion(config: {
  topic: string;
  depth: number;
  agents: AgentConfig[];
  moderator: { provider: Provider; model: string };
  outputPath?: string;
  outputToStdout: boolean;
  providersConfig: ProvidersConfig;
}): Promise<void> {
  console.log(chalk.bold.cyan('\n🚀 Starting Discussion...\n'));
  console.log(chalk.dim('─'.repeat(60)));
  console.log(chalk.yellow('  Keyboard Controls:'));
  console.log(chalk.dim('    Press ') + chalk.bold('v') + chalk.dim(' to toggle verbose/quiet mode'));
  console.log(chalk.dim('    Press ') + chalk.bold('p') + chalk.dim(' or ') + chalk.bold('space') + chalk.dim(' to skip current agent'));
  console.log(chalk.dim('    Press ') + chalk.bold('s') + chalk.dim(' to soft interrupt (wrap up gracefully)'));
  console.log(chalk.dim('    Press ') + chalk.bold('q') + chalk.dim(' or ') + chalk.bold('Ctrl+C') + chalk.dim(' to quit immediately'));
  console.log(chalk.dim('    Press ') + chalk.bold('h') + chalk.dim(' for help'));
  console.log(chalk.dim('─'.repeat(60) + '\n'));

  // Build agent specs with provider credentials
  const agentSpecs = config.agents.map((a) => {
    const providerCreds = config.providersConfig.providers[a.provider];
    // Include API key in the spec via environment-style
    return `${a.provider}:${a.model}:${a.personality}`;
  });

  // Set up environment variables for providers that need API keys
  for (const agent of config.agents) {
    const creds = config.providersConfig.providers[agent.provider];
    if (creds.apiKey) {
      switch (agent.provider) {
        case 'openai':
          process.env.OPENAI_API_KEY = creds.apiKey;
          break;
        case 'anthropic':
          process.env.ANTHROPIC_API_KEY = creds.apiKey;
          break;
        case 'google':
          process.env.GOOGLE_API_KEY = creds.apiKey;
          break;
        case 'openrouter':
          process.env.OPENROUTER_API_KEY = creds.apiKey;
          break;
      }
    }
    if (creds.baseUrl) {
      switch (agent.provider) {
        case 'ollama':
          process.env.OLLAMA_BASE_URL = creds.baseUrl;
          break;
        case 'lmstudio':
          process.env.LMSTUDIO_BASE_URL = creds.baseUrl;
          break;
      }
    }
  }

  // Same for moderator
  const modCreds = config.providersConfig.providers[config.moderator.provider];
  if (modCreds.apiKey) {
    switch (config.moderator.provider) {
      case 'openai':
        process.env.OPENAI_API_KEY = modCreds.apiKey;
        break;
      case 'anthropic':
        process.env.ANTHROPIC_API_KEY = modCreds.apiKey;
        break;
      case 'google':
        process.env.GOOGLE_API_KEY = modCreds.apiKey;
        break;
      case 'openrouter':
        process.env.OPENROUTER_API_KEY = modCreds.apiKey;
        break;
    }
  }

  const discussionConfig = await buildConfig({
    topic: config.topic,
    depth: config.depth,
    agents: agentSpecs,
    moderatorProvider: config.moderator.provider,
    moderatorModel: config.moderator.model,
    outputPath: config.outputPath,
    outputStdout: config.outputToStdout,
  });

  // Create interrupt controller and set up keyboard listeners
  const interruptController = createInterruptController(true);
  const cleanupListeners = interruptController.setupKeyboardListeners({ showHelp: true });

  const engine = new ConsensusEngine(discussionConfig, interruptController);
  const sessionManager = new SessionManager();

  let currentAgentContent = '';
  let currentModeratorContent = '';
  let currentAgentName = '';

  try {
    for await (const event of engine.runStream()) {
      switch (event.type) {
        case 'phase_change':
          console.log(chalk.blue(`\n${'═'.repeat(60)}`));
          console.log(chalk.blue.bold(` 📍 ${event.phase} - Round ${event.round}`));
          console.log(chalk.blue(`${'═'.repeat(60)}\n`));
          break;

        case 'agent_speaking':
          currentAgentContent = '';
          currentAgentName = event.agentName;
          console.log(chalk.cyan.bold(`\n💬 ${event.agentName}:`));
          if (interruptController.verbose) {
            console.log(chalk.dim('─'.repeat(40)));
          }
          break;

        case 'agent_thinking':
          process.stdout.write(chalk.dim(`\r⏳ ${event.agentName} thinking... (${event.elapsed}s)   `));
          break;

        case 'agent_message_chunk':
          currentAgentContent += event.content;
          if (interruptController.verbose) {
            process.stdout.write(event.content);
          }
          break;

        case 'agent_message_complete':
          if (interruptController.verbose) {
            if (!currentAgentContent) {
              console.log(event.message.content);
            }
            console.log(chalk.dim('\n─'.repeat(40)));
          }
          console.log(chalk.gray(`Stance: ${chalk.bold(event.message.stance)}`));
          if (event.message.keyPoints.length > 0) {
            console.log(chalk.gray('Key points:'));
            event.message.keyPoints.forEach((point) => {
              console.log(chalk.gray(`  • ${point}`));
            });
          }
          currentAgentContent = '';
          currentAgentName = '';
          break;

        case 'agent_skipped':
          console.log(chalk.yellow(`\n⏭️  ${event.agentName} was skipped\n`));
          currentAgentContent = '';
          currentAgentName = '';
          break;

        case 'moderator_speaking':
          currentModeratorContent = '';
          console.log(chalk.yellow.bold('\n🎯 Moderator:'));
          if (interruptController.verbose) {
            console.log(chalk.dim('─'.repeat(40)));
          }
          break;

        case 'moderator_thinking':
          process.stdout.write(chalk.dim(`\r⏳ Moderator thinking... (${event.elapsed}s)   `));
          break;

        case 'moderator_message_chunk':
          currentModeratorContent += event.content;
          if (interruptController.verbose) {
            process.stdout.write(chalk.yellow(event.content));
          }
          break;

        case 'moderator_message_complete':
          if (interruptController.verbose) {
            if (!currentModeratorContent) {
              console.log(chalk.yellow(event.message.content));
            }
            console.log(chalk.dim('\n─'.repeat(40)));
          } else {
            const summary = event.message.content.slice(0, 150);
            console.log(chalk.dim(summary + (event.message.content.length > 150 ? '...' : '')));
          }
          console.log(chalk.gray(`Type: ${event.message.type}`));
          currentModeratorContent = '';
          break;

        case 'round_complete':
          console.log(chalk.dim(`\n${'─'.repeat(60)}`));
          console.log(chalk.dim.italic(`Round ${event.round} complete`));
          console.log(chalk.dim(`${'─'.repeat(60)}\n`));
          break;

        case 'wrapping_up':
          console.log(chalk.yellow.bold('\n⚡ Wrapping up discussion early...\n'));
          break;

        case 'interrupt_soft':
          console.log(chalk.yellow(`\n⚡ ${event.reason}`));
          break;

        case 'interrupt_hard':
          console.log(chalk.red(`\n🛑 ${event.reason}`));
          break;

        case 'consensus_reached':
          console.log(chalk.green.bold('\n✓ Consensus Phase Complete\n'));
          break;

        case 'session_complete':
          await sessionManager.save(engine.getSession());

          console.log(chalk.bold.green('\n' + '═'.repeat(60)));
          console.log(chalk.bold.green(' DISCUSSION COMPLETE'));
          console.log(chalk.bold.green('═'.repeat(60) + '\n'));

          if (config.outputToStdout && event.output) {
            console.log(generateCompactSummary(event.output));
          }

          if (config.outputPath && event.output) {
            await writeMarkdownFile(event.output, config.outputPath);
            console.log(chalk.green(`\n✓ Full output saved to: ${config.outputPath}`));
          }

          console.log(chalk.dim(`\nSession ID: ${engine.getSession().id}`));
          console.log(chalk.dim('Continue this discussion: consensus run --continue ' + engine.getSession().id));
          break;

        case 'error':
          console.error(chalk.red(`\n❌ Error: ${event.error}`));
          break;
      }
    }
  } finally {
    cleanupListeners();
  }
}
