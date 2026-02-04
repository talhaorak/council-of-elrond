import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import { streamSSE } from 'hono/streaming';
import { buildConfig } from '../../config/loader.js';
import { ConsensusEngine } from '../../core/engine.js';
import { generateMarkdown, generateCompactSummary } from '../../output/markdown.js';
import { SessionManager } from '../../output/state.js';
import { getPersonalityTemplates } from '../../agents/personalities/index.js';
import { checkAvailableProviders, getDefaultProvider, getDefaultModel } from '../../providers/index.js';
import {
  detectProviders,
  loadProvidersConfig,
  updateProviderKey,
  getProviderDisplayName,
  type ProvidersConfig,
} from '../../config/providers.js';
import { WorkspaceManager, saveGlobalApiKey } from '../../core/workspace.js';
import {
  VALID_PROVIDERS,
  VALID_ARCHETYPES,
  ARCHETYPE_DESCRIPTIONS,
  PROVIDER_NAMES,
  SUGGESTED_TEAMS,
  getSuggestedModels,
} from '../../config/schema.js';
import { logger } from '../../core/logger.js';
import type { Provider, ConsensusEvent } from '../../core/types.js';

// Cache for provider config
let cachedProvidersConfig: ProvidersConfig | null = null;
let currentWorkspace: WorkspaceManager | null = null;

const app = new Hono();

// Enable CORS for development
app.use('/*', cors());

// Serve static files from web/dist in production
app.use('/assets/*', serveStatic({ root: './web/dist' }));

// ============================================================================
// API ROUTES
// ============================================================================

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Get available providers with full config
app.get('/api/providers', async (c) => {
  // Use cached config or load fresh
  if (!cachedProvidersConfig) {
    cachedProvidersConfig = await loadProvidersConfig();
  }
  
  const config = cachedProvidersConfig;
  
  return c.json({
    providers: Object.values(config.providers).map((p) => ({
      id: p.provider,
      name: getProviderDisplayName(p.provider),
      available: p.isConfigured,
      isDefault: config.defaultProvider === p.provider,
      models: p.models,
      defaultModel: p.defaultModel,
      source: p.source,
      needsApiKey: ['openai', 'anthropic', 'google', 'openrouter'].includes(p.provider),
      isLocal: ['ollama', 'lmstudio'].includes(p.provider),
    })),
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  });
});

// Refresh provider detection
app.post('/api/providers/refresh', async (c) => {
  cachedProvidersConfig = await detectProviders();
  return c.json({ success: true });
});

// Update provider API key
app.post('/api/providers/:provider/key', async (c) => {
  const provider = c.req.param('provider') as Provider;
  const body = await c.req.json();
  const { apiKey, saveGlobally } = body;
  
  if (!apiKey) {
    return c.json({ error: 'API key is required' }, 400);
  }
  
  if (!cachedProvidersConfig) {
    cachedProvidersConfig = await loadProvidersConfig();
  }
  
  cachedProvidersConfig = updateProviderKey(cachedProvidersConfig, provider, apiKey);
  
  // Save globally if requested
  if (saveGlobally) {
    await saveGlobalApiKey(provider, apiKey);
    logger.info('API', `Saved ${provider} API key globally`);
  } else if (currentWorkspace) {
    await currentWorkspace.saveApiKey(provider, apiKey, false);
    logger.info('API', `Saved ${provider} API key to workspace`);
  }
  
  // Also set in environment for immediate use
  switch (provider) {
    case 'openai':
      process.env.OPENAI_API_KEY = apiKey;
      break;
    case 'anthropic':
      process.env.ANTHROPIC_API_KEY = apiKey;
      break;
    case 'google':
      process.env.GOOGLE_API_KEY = apiKey;
      break;
    case 'openrouter':
      process.env.OPENROUTER_API_KEY = apiKey;
      break;
  }
  
  return c.json({ success: true });
});

// Get personality templates
app.get('/api/personalities', async (c) => {
  const templates = await getPersonalityTemplates();
  
  return c.json({
    archetypes: VALID_ARCHETYPES.map((a) => ({
      id: a,
      name: a.charAt(0).toUpperCase() + a.slice(1).replace('-', ' '),
      description: ARCHETYPE_DESCRIPTIONS[a],
    })),
    templates,
    suggestedTeams: Object.entries(SUGGESTED_TEAMS).map(([id, team]) => ({
      id,
      name: team.name,
      description: team.description,
      archetypes: team.archetypes,
    })),
  });
});

// Get saved sessions
app.get('/api/sessions', async (c) => {
  const manager = new SessionManager();
  const sessions = await manager.list();
  return c.json({ sessions });
});

// Get session details
app.get('/api/sessions/:id', async (c) => {
  const manager = new SessionManager();
  const session = await manager.load(c.req.param('id'));
  
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  
  return c.json({ session });
});

// Delete session
app.delete('/api/sessions/:id', async (c) => {
  const manager = new SessionManager();
  const deleted = await manager.delete(c.req.param('id'));
  return c.json({ deleted });
});

// Start a new discussion (returns SSE stream)
app.post('/api/discussions', async (c) => {
  const body = await c.req.json();
  
  try {
    const config = await buildConfig({
      topic: body.topic,
      depth: body.depth,
      agents: body.agents, // Array of "provider:model:personality" strings
      moderatorProvider: body.moderator?.provider,
      moderatorModel: body.moderator?.model,
    });
    
    if (body.limits) {
      config.limits = {
        ...config.limits,
        ...body.limits,
      };
    }

    // Save config to workspace before starting
    if (currentWorkspace) {
      await currentWorkspace.saveConfig({
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
      logger.info('API', 'Saved config to workspace');
    }

    // Create engine with workspace for auto-save
    const engine = new ConsensusEngine(config, undefined, currentWorkspace || undefined);
    const sessionManager = new SessionManager();

    // Return SSE stream
    return streamSSE(c, async (stream) => {
      // Set up keep-alive interval to prevent timeout during long LLM generations
      const keepAliveInterval = setInterval(async () => {
        try {
          await stream.writeSSE({
            event: 'keepalive',
            data: JSON.stringify({ timestamp: Date.now() }),
          });
        } catch {
          // Stream might be closed, ignore
        }
      }, 5000); // Send keepalive every 5 seconds

      try {
        for await (const event of engine.runStream()) {
          // Log each event for debugging
          logger.debug('SSE', `Emitting event: ${event.type}`);
          
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }

        // Save session at the end
        await sessionManager.save(engine.getSession());
        
        // Mark completed in workspace
        if (currentWorkspace) {
          await currentWorkspace.markCompleted(engine.getSession().id);
        }

        // Send final session info
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            sessionId: engine.getSession().id,
            consensusReached: engine.getSession().consensusReached,
          }),
        });
      } catch (error) {
        logger.error('API', 'Discussion error', { error: error instanceof Error ? error.message : error });
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        });
      } finally {
        clearInterval(keepAliveInterval);
      }
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Configuration error' },
      400
    );
  }
});

// Continue a session
app.post('/api/sessions/:id/continue', async (c) => {
  const manager = new SessionManager();
  const session = await manager.load(c.req.param('id'));
  
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const body = await c.req.json();
  const additionalRounds = body.additionalRounds || 2;

  const engine = await ConsensusEngine.resume(session, additionalRounds, {
    humanDecision: body.humanDecision,
    resolveBlockers: body.resolveBlockers,
    overrideLimits: body.overrideLimits,
  });

  return streamSSE(c, async (stream) => {
    // Set up keep-alive interval to prevent timeout
    const keepAliveInterval = setInterval(async () => {
      try {
        await stream.writeSSE({
          event: 'keepalive',
          data: JSON.stringify({ timestamp: Date.now() }),
        });
      } catch {
        // Stream might be closed, ignore
      }
    }, 5000);

    try {
      for await (const event of engine.runStream()) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      }

      await manager.save(engine.getSession());

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          sessionId: engine.getSession().id,
          consensusReached: engine.getSession().consensusReached,
        }),
      });
    } catch (error) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      });
    } finally {
      clearInterval(keepAliveInterval);
    }
  });
});

// Export session as markdown
app.get('/api/sessions/:id/export', async (c) => {
  const manager = new SessionManager();
  const session = await manager.load(c.req.param('id'));
  
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const output = {
    session,
    summary: {
      topic: session.config.topic,
      participantCount: session.config.agents.length,
      roundCount: session.config.depth,
      consensusReached: session.consensusReached,
      finalConsensus: session.finalConsensus || '',
      keyAgreements: [],
      remainingDisagreements: [],
      agentSummaries: session.config.agents.map((a) => ({
        agentName: a.name,
        personality: a.personality.name,
        keyContributions: [],
      })),
    },
    transcript: session.messages,
  };

  const markdown = generateMarkdown(output);
  
  return c.text(markdown, 200, {
    'Content-Type': 'text/markdown',
    'Content-Disposition': `attachment; filename="consensus-${session.id}.md"`,
  });
});

// ============================================================================
// SERVE FRONTEND
// ============================================================================

// Serve the frontend HTML
const frontendHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bot Consensus</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            primary: '#6366f1',
            secondary: '#8b5cf6',
          }
        }
      }
    }
  </script>
  <style>
    @keyframes pulse-slow {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .animate-pulse-slow {
      animation: pulse-slow 2s ease-in-out infinite;
    }
    .scrollbar-thin::-webkit-scrollbar {
      width: 6px;
    }
    .scrollbar-thin::-webkit-scrollbar-track {
      background: #1f2937;
    }
    .scrollbar-thin::-webkit-scrollbar-thumb {
      background: #4b5563;
      border-radius: 3px;
    }
  </style>
</head>
<body class="dark bg-gray-900 text-gray-100 min-h-screen">
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;

// Inline the React app
const frontendJs = `
import { createElement as h, useState, useEffect, useCallback, Fragment } from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client';

// ============================================================================
// API Client
// ============================================================================
const api = {
  async getProviders() {
    const res = await fetch('/api/providers');
    return res.json();
  },
  async refreshProviders() {
    const res = await fetch('/api/providers/refresh', { method: 'POST' });
    return res.json();
  },
  async setApiKey(provider, apiKey, saveGlobally = true) {
    const res = await fetch('/api/providers/' + provider + '/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, saveGlobally }),
    });
    return res.json();
  },
  async getPersonalities() {
    const res = await fetch('/api/personalities');
    return res.json();
  },
  async getSessions() {
    const res = await fetch('/api/sessions');
    return res.json();
  },
  async getSession(id) {
    const res = await fetch('/api/sessions/' + id);
    return res.json();
  },
  continueSession(id, payload, onEvent) {
    const seenEvents = new Set();
    return new Promise((resolve, reject) => {
      fetch('/api/sessions/' + id + '/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function processChunk() {
          reader.read().then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));

                  let eventKey = data.type;
                  if (data.message?.timestamp) {
                    eventKey += ':' + data.message.timestamp;
                  }
                  if (data.message?.agentId) {
                    eventKey += ':' + data.message.agentId;
                  }

                  if (data.type === 'agent_message_complete' || data.type === 'moderator_message_complete') {
                    if (!seenEvents.has(eventKey)) {
                      seenEvents.add(eventKey);
                      onEvent(data);
                    }
                  } else {
                    onEvent(data);
                  }
                } catch (e) {
                  console.error('[SSE] Parse error:', e);
                }
              }
            }

            processChunk();
          }).catch(reject);
        }

        processChunk();
      }).catch(reject);
    });
  },
  startDiscussion(config, onEvent) {
    const seenEvents = new Set();
    
    return new Promise((resolve, reject) => {
      fetch('/api/discussions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      }).then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function processChunk() {
          reader.read().then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  
                  // Create event key for deduplication
                  let eventKey = data.type;
                  if (data.message?.timestamp) {
                    eventKey += ':' + data.message.timestamp;
                  }
                  if (data.message?.agentId) {
                    eventKey += ':' + data.message.agentId;
                  }
                  
                  // Skip if we've seen this exact event
                  if (data.type === 'agent_message_complete' || data.type === 'moderator_message_complete') {
                    if (seenEvents.has(eventKey)) {
                      console.log('[SSE] Skipping duplicate:', eventKey);
                    } else {
                      seenEvents.add(eventKey);
                      console.log('[SSE] Event:', data.type);
                      onEvent(data);
                    }
                  } else {
                    console.log('[SSE] Event:', data.type);
                    onEvent(data);
                  }
                } catch (e) {
                  console.error('[SSE] Parse error:', e);
                }
              }
            }
            
            processChunk();
          }).catch(reject);
        }
        
        processChunk();
      }).catch(reject);
    });
  }
};

// ============================================================================
// Components
// ============================================================================

function formatAbortReason(reason) {
  if (!reason) return '';
  switch (reason.type) {
    case 'needs_human':
      return 'Paused for human decision: critical blockers must be reviewed.';
    case 'blocker_limit':
      return 'Stopped: blocker limit exceeded (' + reason.count + ' >= ' + reason.limit + ').';
    case 'cost_limit':
      return 'Stopped: cost limit exceeded ($' + reason.spent.toFixed(2) + ' > $' + reason.limit.toFixed(2) + ').';
    case 'time_limit':
      return 'Stopped: time limit exceeded (' + Math.round(reason.elapsed / 1000) + 's > ' + Math.round(reason.limit / 1000) + 's).';
    case 'token_limit':
      return 'Stopped: token limit exceeded (' + reason.used + ' > ' + reason.limit + ').';
    case 'deadlock':
      return 'Stopped: deadlock detected. ' + reason.description;
    case 'user_interrupt':
      return 'Stopped by user (' + reason.interruptType + ').';
    default:
      return 'Discussion stopped due to limits.';
  }
}

function Header() {
  return h('header', { className: 'bg-gray-800 border-b border-gray-700 px-6 py-4' },
    h('div', { className: 'flex items-center justify-between max-w-7xl mx-auto' },
      h('div', { className: 'flex items-center gap-3' },
        h('span', { className: 'text-3xl' }, '🤖'),
        h('div', null,
          h('h1', { className: 'text-xl font-bold text-white' }, 'Bot Consensus'),
          h('p', { className: 'text-sm text-gray-400' }, 'Multi-agent AI Discussion System')
        )
      ),
      h('nav', { className: 'flex gap-4' },
        h('a', { href: '#', className: 'text-gray-300 hover:text-white transition' }, 'New Discussion'),
        h('a', { href: '#sessions', className: 'text-gray-300 hover:text-white transition' }, 'Sessions')
      )
    )
  );
}

function WizardStep({ step, title, description, isActive, isComplete }) {
  return h('div', { 
    className: 'flex items-center gap-3 ' + (isActive ? 'text-white' : isComplete ? 'text-green-400' : 'text-gray-500')
  },
    h('div', { 
      className: 'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' + 
        (isActive ? 'bg-primary' : isComplete ? 'bg-green-500' : 'bg-gray-700')
    }, isComplete ? '✓' : step),
    h('div', null,
      h('div', { className: 'font-medium' }, title),
      h('div', { className: 'text-xs text-gray-400' }, description)
    )
  );
}

function ProviderSelect({ providers, value, onChange, onConfigure }) {
  return h('div', { className: 'space-y-4' },
    h('div', { className: 'grid grid-cols-2 md:grid-cols-3 gap-3' },
      providers.map(provider =>
        h('button', {
          key: provider.id,
          onClick: () => provider.available ? onChange(provider.id) : onConfigure?.(provider.id),
          className: 'p-4 rounded-lg border-2 transition relative ' + 
            (value === provider.id 
              ? 'border-primary bg-primary/20' 
              : provider.available
                ? 'border-gray-700 hover:border-gray-600 bg-gray-800'
                : 'border-gray-700 bg-gray-800/50 opacity-60')
        },
          h('div', { className: 'font-medium flex items-center gap-2' }, 
            provider.name,
            provider.available 
              ? h('span', { className: 'text-green-400 text-xs' }, '✓')
              : h('span', { className: 'text-red-400 text-xs' }, '✗')
          ),
          h('div', { className: 'text-xs text-gray-400 mt-1' }, 
            provider.available ? provider.defaultModel : (provider.needsApiKey ? 'Needs API key' : 'Not running')
          ),
          provider.source && h('div', { className: 'text-xs text-gray-500 mt-1' }, provider.source)
        )
      )
    )
  );
}

function ProviderConfig({ providers, onUpdate, onRefresh }) {
  const [configuring, setConfiguring] = useState(null);
  const [showSelector, setShowSelector] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [saveGlobally, setSaveGlobally] = useState(true);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!apiKey || !configuring) return;
    setSaving(true);
    await api.setApiKey(configuring, apiKey, saveGlobally);
    await onRefresh();
    setConfiguring(null);
    setApiKey('');
    setSaving(false);
  };

  const providersNeedingKey = providers.filter(p => p.needsApiKey);
  const unconfiguredProviders = providersNeedingKey.filter(p => !p.available);

  // Show API key input form
  if (configuring) {
    const provider = providers.find(p => p.id === configuring);
    const keyHints = {
      openai: 'Get your key at platform.openai.com/api-keys',
      anthropic: 'Get your key at console.anthropic.com',
      google: 'Get your key at aistudio.google.com/apikey',
      openrouter: 'Get your key at openrouter.ai/keys'
    };
    return h('div', { className: 'bg-gray-700 rounded-lg p-4 mt-4' },
      h('h3', { className: 'font-bold mb-2' }, '🔑 Configure ' + provider?.name),
      h('p', { className: 'text-xs text-gray-400 mb-3' }, keyHints[configuring] || 'Enter your API key'),
      h('input', {
        type: 'password',
        value: apiKey,
        onChange: e => setApiKey(e.target.value),
        placeholder: 'Enter API key...',
        className: 'w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white mb-3'
      }),
      h('label', { className: 'flex items-center gap-2 text-sm text-gray-300 mb-3' },
        h('input', {
          type: 'checkbox',
          checked: saveGlobally,
          onChange: e => setSaveGlobally(e.target.checked),
          className: 'rounded'
        }),
        'Save globally (available for all projects)'
      ),
      h('div', { className: 'flex gap-2' },
        h('button', {
          onClick: handleSave,
          disabled: saving || !apiKey,
          className: 'px-4 py-2 bg-primary rounded-lg disabled:opacity-50'
        }, saving ? 'Saving...' : 'Save'),
        h('button', {
          onClick: () => { setConfiguring(null); setApiKey(''); },
          className: 'px-4 py-2 bg-gray-600 rounded-lg'
        }, 'Cancel')
      )
    );
  }

  // Show provider selector
  if (showSelector) {
    return h('div', { className: 'bg-gray-700 rounded-lg p-4 mt-4' },
      h('h3', { className: 'font-bold mb-3' }, '🔑 Select Provider to Configure'),
      h('div', { className: 'grid grid-cols-2 gap-2 mb-3' },
        providersNeedingKey.map(p => 
          h('button', {
            key: p.id,
            onClick: () => { setConfiguring(p.id); setShowSelector(false); },
            className: 'p-3 text-left rounded-lg border transition ' + 
              (p.available 
                ? 'border-green-600 bg-green-900/20 hover:bg-green-900/40' 
                : 'border-gray-600 bg-gray-800 hover:bg-gray-700')
          },
            h('div', { className: 'flex items-center gap-2' },
              h('span', { className: 'font-medium' }, p.name),
              p.available && h('span', { className: 'text-green-400 text-xs' }, '✓')
            ),
            h('div', { className: 'text-xs text-gray-400' }, 
              p.available ? 'Click to update key' : 'Not configured'
            )
          )
        )
      ),
      h('button', {
        onClick: () => setShowSelector(false),
        className: 'text-sm text-gray-400 hover:text-white'
      }, '← Back')
    );
  }

  return h('div', { className: 'flex gap-2 mt-4' },
    h('button', {
      onClick: onRefresh,
      className: 'px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm'
    }, '🔄 Refresh'),
    h('button', {
      onClick: () => setShowSelector(true),
      className: 'px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm'
    }, '🔑 Configure API Keys' + (unconfiguredProviders.length > 0 ? ' (' + unconfiguredProviders.length + ' needed)' : ''))
  );
}

function PersonalityCard({ personality, selected, onClick }) {
  return h('button', {
    onClick,
    className: 'p-4 rounded-lg border-2 text-left transition ' + 
      (selected 
        ? 'border-primary bg-primary/20' 
        : 'border-gray-700 hover:border-gray-600 bg-gray-800')
  },
    h('div', { className: 'font-medium capitalize' }, personality.id.replace('-', ' ')),
    h('div', { className: 'text-sm text-gray-400 mt-1' }, personality.description)
  );
}

function AgentBadge({ agent, onRemove, onEdit }) {
  return h('div', { 
    className: 'inline-flex items-center gap-2 px-3 py-2 bg-gray-700 rounded-lg text-sm'
  },
    h('div', { className: 'flex flex-col' },
      h('span', { className: 'capitalize font-medium' }, agent.personality),
      h('span', { className: 'text-xs text-gray-400' }, agent.provider + ':' + agent.model)
    ),
    h('div', { className: 'flex gap-1' },
      onEdit && h('button', { 
        onClick: onEdit,
        className: 'text-gray-400 hover:text-primary'
      }, '✎'),
      h('button', { 
        onClick: onRemove,
        className: 'text-gray-400 hover:text-red-400'
      }, '×')
    )
  );
}

function AgentConfigModal({ providers, personalities, agent, onSave, onClose }) {
  const [provider, setProvider] = useState(agent?.provider || providers[0]?.id);
  const [model, setModel] = useState(agent?.model || '');
  const [personality, setPersonality] = useState(agent?.personality || '');

  const currentProvider = providers.find(p => p.id === provider);
  
  useEffect(() => {
    if (currentProvider && !model) {
      setModel(currentProvider.defaultModel);
    }
  }, [provider, currentProvider]);

  // Group models by provider prefix and sort with major providers at top
  const getGroupedModels = () => {
    if (!currentProvider?.models) return [];
    
    const models = currentProvider.models;
    const groups = {};
    const ungrouped = [];
    
    // Major providers to show at top (in order)
    const majorProviders = ['openai', 'anthropic', 'google', 'x-ai'];
    const providerLabels = {
      'openai': '🟢 OpenAI',
      'anthropic': '🟠 Anthropic', 
      'google': '🔵 Google',
      'x-ai': '⚡ xAI',
      'deepseek': '🔮 DeepSeek',
      'moonshotai': '🌙 Moonshot Kimi',
      'meta-llama': '🦙 Meta Llama',
      'mistralai': '🌀 Mistral',
      'qwen': '🌟 Qwen',
      'cohere': '💎 Cohere',
      'perplexity': '🔍 Perplexity',
      'microsoft': '🪟 Microsoft',
      'other': '📦 Other'
    };
    
    // Group models by prefix
    models.forEach(m => {
      const parts = m.split('/');
      if (parts.length > 1) {
        const prefix = parts[0].toLowerCase();
        if (!groups[prefix]) groups[prefix] = [];
        groups[prefix].push(m);
      } else {
        ungrouped.push(m);
      }
    });
    
    // Sort within each group
    Object.keys(groups).forEach(key => {
      groups[key].sort();
    });
    
    // Build sorted group list
    const sortedGroups = [];
    
    // Add major providers first (if they exist)
    majorProviders.forEach(mp => {
      if (groups[mp] && groups[mp].length > 0) {
        sortedGroups.push({
          label: providerLabels[mp] || mp,
          models: groups[mp]
        });
        delete groups[mp];
      }
    });
    
    // Add remaining providers alphabetically
    Object.keys(groups).sort().forEach(key => {
      sortedGroups.push({
        label: providerLabels[key] || key.charAt(0).toUpperCase() + key.slice(1),
        models: groups[key]
      });
    });
    
    // Add ungrouped models if any
    if (ungrouped.length > 0) {
      sortedGroups.push({
        label: providerLabels['other'],
        models: ungrouped.sort()
      });
    }
    
    return sortedGroups;
  };

  const groupedModels = getGroupedModels();
  const hasGroups = groupedModels.length > 1 || (groupedModels.length === 1 && groupedModels[0].models.length > 3);

  return h('div', { className: 'fixed inset-0 bg-black/50 flex items-center justify-center z-50' },
    h('div', { className: 'bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4' },
      h('h3', { className: 'text-lg font-bold mb-4' }, agent ? 'Edit Agent' : 'Add Agent'),
      
      h('div', { className: 'space-y-4' },
        h('div', null,
          h('label', { className: 'block text-sm text-gray-400 mb-1' }, 'Personality'),
          h('select', {
            value: personality,
            onChange: e => setPersonality(e.target.value),
            className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg'
          },
            h('option', { value: '' }, 'Select personality...'),
            personalities.map(p => h('option', { key: p.id, value: p.id }, p.id + ' - ' + p.description))
          )
        ),
        
        h('div', null,
          h('label', { className: 'block text-sm text-gray-400 mb-1' }, 'Provider'),
          h('select', {
            value: provider,
            onChange: e => { setProvider(e.target.value); setModel(''); },
            className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg'
          },
            providers.filter(p => p.available).map(p => 
              h('option', { key: p.id, value: p.id }, p.name)
            )
          )
        ),
        
        h('div', null,
          h('label', { className: 'block text-sm text-gray-400 mb-1' }, 'Model'),
          h('select', {
            value: model,
            onChange: e => setModel(e.target.value),
            className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg'
          },
            hasGroups 
              ? groupedModels.map(group => 
                  h('optgroup', { key: group.label, label: group.label },
                    group.models.map(m => h('option', { key: m, value: m }, m.split('/').pop() || m))
                  )
                )
              : currentProvider?.models.map(m => 
                  h('option', { key: m, value: m }, m)
                )
          )
        )
      ),
      
      h('div', { className: 'flex gap-2 mt-6' },
        h('button', {
          onClick: () => onSave({ provider, model, personality }),
          disabled: !personality || !provider || !model,
          className: 'flex-1 py-2 bg-primary rounded-lg disabled:opacity-50'
        }, 'Save'),
        h('button', {
          onClick: onClose,
          className: 'flex-1 py-2 bg-gray-600 rounded-lg'
        }, 'Cancel')
      )
    )
  );
}

function MessageBubble({ message, isStreaming }) {
  const isAgent = message.type === 'agent' || message.agentId;
  const isModerator = message.type === 'moderator';
  
  return h('div', { 
    className: 'p-4 rounded-lg ' + 
      (isModerator ? 'bg-yellow-900/30 border-l-4 border-yellow-500' : 'bg-gray-800')
  },
    h('div', { className: 'flex items-center gap-2 mb-2' },
      h('span', { className: 'text-lg' }, isModerator ? '🎯' : '💬'),
      h('span', { className: 'font-bold ' + (isModerator ? 'text-yellow-400' : 'text-cyan-400') },
        message.agentName || message.name || 'Moderator'
      ),
      message.stance && h('span', { 
        className: 'text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300'
      }, message.stance),
      isStreaming && h('span', { className: 'animate-pulse-slow text-primary' }, '●')
    ),
    h('div', { className: 'text-gray-300 whitespace-pre-wrap' }, message.content),
    message.keyPoints && message.keyPoints.length > 0 && h('div', { 
      className: 'mt-2 pt-2 border-t border-gray-700'
    },
      h('div', { className: 'text-xs text-gray-400' }, 'Key Points:'),
      h('div', { className: 'text-sm text-gray-300' }, message.keyPoints.join(' • '))
    )
  );
}

// ============================================================================
// Main App
// ============================================================================

function App() {
  const [view, setView] = useState('wizard'); // wizard, discussion, sessions
  const [step, setStep] = useState(1);
  const [providers, setProviders] = useState([]);
  const [personalities, setPersonalities] = useState({ archetypes: [], suggestedTeams: [] });
  
  // Config state
  const [topic, setTopic] = useState('');
  const [depth, setDepth] = useState(3);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [agents, setAgents] = useState([]);
  const [limits, setLimits] = useState({
    maxCostUsd: 5.0,
    maxDurationMinutes: 10,
    maxTokens: 100000,
    maxBlockers: 20,
    requireHumanDecision: false,
  });
  
  // Discussion state
  const [isRunning, setIsRunning] = useState(false);
  const [messages, setMessages] = useState([]);
  const [currentPhase, setCurrentPhase] = useState('');
  const [currentRound, setCurrentRound] = useState(0);
  const [streamingContent, setStreamingContent] = useState('');
  const [currentSpeaker, setCurrentSpeaker] = useState('');
  const [sessionId, setSessionId] = useState('');
  
  // New: Cost and metrics tracking
  const [totalCost, setTotalCost] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [blockers, setBlockers] = useState([]);
  const [decisionGate, setDecisionGate] = useState(null);
  const [abortReason, setAbortReason] = useState(null);
  const [humanDecisionText, setHumanDecisionText] = useState('');
  const [isContinuing, setIsContinuing] = useState(false);

  // Agent modal state
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [editingAgentIndex, setEditingAgentIndex] = useState(null);

  // Load initial data
  const loadProviders = async () => {
    const data = await api.getProviders();
    setProviders(data.providers);
    const defaultP = data.providers.find(p => p.isDefault && p.available) || data.providers.find(p => p.available);
    if (defaultP) {
      setSelectedProvider(defaultP.id);
      setSelectedModel(defaultP.defaultModel);
    }
  };

  useEffect(() => {
    loadProviders();
    api.getPersonalities().then(setPersonalities);
  }, []);

  const addAgent = (personalityId) => {
    if (agents.length < 6) {
      const provider = providers.find(p => p.id === selectedProvider);
      setAgents([...agents, { 
        provider: selectedProvider, 
        model: provider?.defaultModel || selectedModel, 
        personality: personalityId 
      }]);
    }
  };

  const removeAgent = (index) => {
    setAgents(agents.filter((_, i) => i !== index));
  };

  const editAgent = (index) => {
    setEditingAgentIndex(index);
    setShowAgentModal(true);
  };

  const saveAgent = (agentConfig) => {
    if (editingAgentIndex !== null) {
      const newAgents = [...agents];
      newAgents[editingAgentIndex] = agentConfig;
      setAgents(newAgents);
    } else {
      setAgents([...agents, agentConfig]);
    }
    setShowAgentModal(false);
    setEditingAgentIndex(null);
  };

  const useSuggestedTeam = (team) => {
    const provider = providers.find(p => p.id === selectedProvider);
    setAgents(team.archetypes.map(p => ({
      provider: selectedProvider,
      model: provider?.defaultModel || selectedModel,
      personality: p
    })));
  };

  const startDiscussion = async () => {
    setView('discussion');
    setIsRunning(true);
    setMessages([]);
    setAbortReason(null);
    setDecisionGate(null);
    setBlockers([]);
    setCurrentPhase('');
    setCurrentRound(0);
    setStreamingContent('');
    setCurrentSpeaker('');
    setTotalCost(0);
    setTotalTokens(0);
    setSessionId('');
    
    const config = {
      topic,
      depth,
      agents: agents.map(a => a.provider + ':' + a.model + ':' + a.personality),
      moderator: { provider: selectedProvider, model: selectedModel },
      limits: {
        maxCostUsd: limits.maxCostUsd,
        maxDurationMs: limits.maxDurationMinutes * 60 * 1000,
        maxTokens: limits.maxTokens,
        maxBlockers: limits.maxBlockers,
        requireHumanDecision: limits.requireHumanDecision,
      }
    };

    try {
      await api.startDiscussion(config, (event) => {
        switch (event.type) {
          case 'phase_change':
            setCurrentPhase(event.phase);
            setCurrentRound(event.round);
            break;
          case 'agent_speaking':
            setCurrentSpeaker(event.agentName);
            setStreamingContent('');
            break;
          case 'agent_thinking':
            setStreamingContent('Thinking... (' + event.elapsed + 's)');
            break;
          case 'agent_message_chunk':
            setStreamingContent(prev => prev + event.content);
            break;
          case 'agent_message_complete':
            // Add message only if not already present (deduplication)
            setMessages(prev => {
              const exists = prev.some(m => 
                m.agentId === event.message.agentId && 
                m.timestamp === event.message.timestamp
              );
              if (exists) return prev;
              return [...prev, event.message];
            });
            setCurrentSpeaker('');
            setStreamingContent('');
            break;
          case 'moderator_speaking':
            setCurrentSpeaker('Moderator');
            setStreamingContent('');
            break;
          case 'moderator_thinking':
            setStreamingContent('Thinking... (' + event.elapsed + 's)');
            break;
          case 'moderator_message_chunk':
            setStreamingContent(prev => prev + event.content);
            break;
          case 'moderator_message_complete':
            // Add message only if not already present (deduplication)
            setMessages(prev => {
              const exists = prev.some(m => 
                m.type === 'moderator' && 
                m.timestamp === event.message.timestamp
              );
              if (exists) return prev;
              return [...prev, { ...event.message, type: 'moderator' }];
            });
            setCurrentSpeaker('');
            setStreamingContent('');
            break;
          case 'session_complete':
            setSessionId(event.output?.session?.id || '');
            setIsRunning(false);
            // Update final cost and metrics
            if (event.output?.session?.costSummary) {
              setTotalCost(event.output.session.costSummary.totalCost);
              setTotalTokens(event.output.session.costSummary.totalTokens?.totalTokens || 0);
            }
            break;
          // New event handlers
          case 'cost_update':
            setTotalCost(event.totalCost);
            if (event.cost?.tokens) {
              setTotalTokens(prev => prev + (event.cost.tokens.totalTokens || 0));
            }
            break;
          case 'blocker_raised':
            setBlockers(prev => [...prev, event.blocker]);
            break;
          case 'blocker_resolved':
            setBlockers(prev => prev.map(b => 
              b.id === event.blockerId 
                ? { ...b, status: 'addressed', resolution: event.resolution }
                : b
            ));
            break;
          case 'decision_gate':
            setDecisionGate(event.gate);
            break;
          case 'abort':
            setIsRunning(false);
            setAbortReason(event.reason);
            setCurrentSpeaker('');
            setStreamingContent('');
            console.warn('Discussion aborted:', event.reason);
            break;
        }
      });
    } catch (error) {
      console.error('Discussion error:', error);
      setIsRunning(false);
    }
  };

  const handleContinue = async (payload) => {
    if (!sessionId) return;
    setIsContinuing(true);
    setIsRunning(true);
    setAbortReason(null);

    try {
      await api.continueSession(sessionId, payload, (event) => {
        switch (event.type) {
          case 'phase_change':
            setCurrentPhase(event.phase);
            setCurrentRound(event.round);
            break;
          case 'agent_speaking':
            setCurrentSpeaker(event.agentName);
            setStreamingContent('');
            break;
          case 'agent_thinking':
            setStreamingContent('Thinking... (' + event.elapsed + 's)');
            break;
          case 'agent_message_chunk':
            setStreamingContent(prev => prev + event.content);
            break;
          case 'agent_message_complete':
            setMessages(prev => {
              const exists = prev.some(m =>
                m.agentId === event.message.agentId &&
                m.timestamp === event.message.timestamp
              );
              if (exists) return prev;
              return [...prev, event.message];
            });
            setCurrentSpeaker('');
            setStreamingContent('');
            break;
          case 'moderator_speaking':
            setCurrentSpeaker('Moderator');
            setStreamingContent('');
            break;
          case 'moderator_thinking':
            setStreamingContent('Thinking... (' + event.elapsed + 's)');
            break;
          case 'moderator_message_chunk':
            setStreamingContent(prev => prev + event.content);
            break;
          case 'moderator_message_complete':
            setMessages(prev => {
              const exists = prev.some(m =>
                m.type === 'moderator' &&
                m.timestamp === event.message.timestamp
              );
              if (exists) return prev;
              return [...prev, { ...event.message, type: 'moderator' }];
            });
            setCurrentSpeaker('');
            setStreamingContent('');
            break;
          case 'session_complete':
            setSessionId(event.output?.session?.id || '');
            setIsRunning(false);
            if (event.output?.session?.costSummary) {
              setTotalCost(event.output.session.costSummary.totalCost);
              setTotalTokens(event.output.session.costSummary.totalTokens?.totalTokens || 0);
            }
            break;
          case 'cost_update':
            setTotalCost(event.totalCost);
            if (event.cost?.tokens) {
              setTotalTokens(prev => prev + (event.cost.tokens.totalTokens || 0));
            }
            break;
          case 'blocker_raised':
            setBlockers(prev => [...prev, event.blocker]);
            break;
          case 'blocker_resolved':
            setBlockers(prev => prev.map(b =>
              b.id === event.blockerId
                ? { ...b, status: 'addressed', resolution: event.resolution }
                : b
            ));
            break;
          case 'decision_gate':
            setDecisionGate(event.gate);
            break;
          case 'abort':
            setIsRunning(false);
            setAbortReason(event.reason);
            setCurrentSpeaker('');
            setStreamingContent('');
            console.warn('Discussion aborted:', event.reason);
            break;
        }
      });
    } catch (error) {
      console.error('Continue error:', error);
      setIsRunning(false);
    } finally {
      setIsContinuing(false);
    }
  };

  // Render wizard
  if (view === 'wizard') {
    return h(Fragment, null,
      h(Header),
      h('main', { className: 'max-w-4xl mx-auto px-6 py-8' },
        // Progress steps
        h('div', { className: 'flex justify-between mb-8' },
          h(WizardStep, { step: 1, title: 'Topic', description: 'What to discuss', isActive: step === 1, isComplete: step > 1 }),
          h(WizardStep, { step: 2, title: 'Provider', description: 'AI backend', isActive: step === 2, isComplete: step > 2 }),
          h(WizardStep, { step: 3, title: 'Agents', description: 'Personalities', isActive: step === 3, isComplete: step > 3 }),
          h(WizardStep, { step: 4, title: 'Limits', description: 'Safety + budget', isActive: step === 4, isComplete: step > 4 }),
          h(WizardStep, { step: 5, title: 'Start', description: 'Begin discussion', isActive: step === 5, isComplete: false })
        ),

        // Step content
        h('div', { className: 'bg-gray-800 rounded-xl p-6' },
          // Step 1: Topic
          step === 1 && h('div', null,
            h('h2', { className: 'text-xl font-bold mb-4' }, 'What should the agents discuss?'),
            h('textarea', {
              value: topic,
              onChange: e => setTopic(e.target.value),
              placeholder: 'Enter a topic for discussion...',
              className: 'w-full h-32 px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-primary resize-none'
            }),
            h('div', { className: 'mt-4' },
              h('label', { className: 'block text-sm text-gray-400 mb-2' }, 'Discussion Depth (rounds)'),
              h('input', {
                type: 'range',
                min: 2,
                max: 5,
                value: depth,
                onChange: e => setDepth(parseInt(e.target.value)),
                className: 'w-full'
              }),
              h('div', { className: 'text-center text-lg font-bold text-primary' }, depth + ' rounds')
            )
          ),

          // Step 2: Provider
          step === 2 && h('div', null,
            h('h2', { className: 'text-xl font-bold mb-4' }, 'Configure AI Providers'),
            h('p', { className: 'text-gray-400 mb-4' }, 'Select your default provider. You can use different providers per agent in the next step.'),
            h(ProviderSelect, { 
              providers, 
              value: selectedProvider, 
              onChange: (id) => {
                setSelectedProvider(id);
                const p = providers.find(pr => pr.id === id);
                if (p) setSelectedModel(p.defaultModel);
              }
            }),
            h(ProviderConfig, { 
              providers, 
              onRefresh: loadProviders 
            })
          ),

          // Step 3: Agents
          step === 3 && h('div', null,
            h('h2', { className: 'text-xl font-bold mb-4' }, 'Configure Agents'),
            h('p', { className: 'text-gray-400 mb-4' }, 'Add agents with different personalities. Click an agent to edit its provider/model.'),
            
            // Selected agents
            agents.length > 0 && h('div', { className: 'mb-4' },
              h('div', { className: 'flex flex-wrap gap-2 mb-2' },
                agents.map((agent, i) => h(AgentBadge, { 
                  key: i, 
                  agent, 
                  onRemove: () => removeAgent(i),
                  onEdit: () => editAgent(i)
                }))
              ),
              h('button', {
                onClick: () => { setEditingAgentIndex(null); setShowAgentModal(true); },
                className: 'text-sm text-primary hover:text-primary/80'
              }, '+ Add custom agent with specific provider/model')
            ),
            
            // Suggested teams
            h('div', { className: 'mb-6' },
              h('h3', { className: 'text-sm text-gray-400 mb-2' }, 'Quick Start - Suggested Teams (uses default provider)'),
              h('div', { className: 'grid grid-cols-2 gap-3' },
                personalities.suggestedTeams?.map(team =>
                  h('button', {
                    key: team.id,
                    onClick: () => useSuggestedTeam(team),
                    className: 'p-3 text-left bg-gray-700 hover:bg-gray-600 rounded-lg transition'
                  },
                    h('div', { className: 'font-medium' }, team.name),
                    h('div', { className: 'text-xs text-gray-400' }, team.description)
                  )
                )
              )
            ),
            
            // Individual personalities
            h('h3', { className: 'text-sm text-gray-400 mb-2' }, 'Or click to add individual personalities (uses default provider)'),
            h('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-3' },
              personalities.archetypes?.map(p =>
                h(PersonalityCard, {
                  key: p.id,
                  personality: p,
                  selected: agents.some(a => a.personality === p.id),
                  onClick: () => addAgent(p.id)
                })
              )
            ),

            // Agent config modal
            showAgentModal && h(AgentConfigModal, {
              providers: providers.filter(p => p.available),
              personalities: personalities.archetypes || [],
              agent: editingAgentIndex !== null ? agents[editingAgentIndex] : null,
              onSave: saveAgent,
              onClose: () => { setShowAgentModal(false); setEditingAgentIndex(null); }
            })
          ),

          // Step 4: Limits
          step === 4 && h('div', null,
            h('h2', { className: 'text-xl font-bold mb-4' }, 'Limits & Safeguards'),
            h('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4' },
              h('div', null,
                h('label', { className: 'block text-gray-400 mb-2' }, 'Max Cost (USD)'),
                h('input', {
                  type: 'number',
                  min: 0,
                  step: 0.1,
                  value: limits.maxCostUsd,
                  onChange: e => setLimits({ ...limits, maxCostUsd: parseFloat(e.target.value) || 0 }),
                  className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white'
                })
              ),
              h('div', null,
                h('label', { className: 'block text-gray-400 mb-2' }, 'Max Time (minutes)'),
                h('input', {
                  type: 'number',
                  min: 1,
                  step: 1,
                  value: limits.maxDurationMinutes,
                  onChange: e => setLimits({ ...limits, maxDurationMinutes: parseInt(e.target.value) || 1 }),
                  className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white'
                })
              ),
              h('div', null,
                h('label', { className: 'block text-gray-400 mb-2' }, 'Max Tokens'),
                h('input', {
                  type: 'number',
                  min: 1000,
                  step: 1000,
                  value: limits.maxTokens,
                  onChange: e => setLimits({ ...limits, maxTokens: parseInt(e.target.value) || 0 }),
                  className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white'
                })
              ),
              h('div', null,
                h('label', { className: 'block text-gray-400 mb-2' }, 'Max Open Blockers'),
                h('input', {
                  type: 'number',
                  min: 1,
                  step: 1,
                  value: limits.maxBlockers,
                  onChange: e => setLimits({ ...limits, maxBlockers: parseInt(e.target.value) || 1 }),
                  className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white'
                })
              )
            ),
            h('div', { className: 'mt-4' },
              h('label', { className: 'flex items-center gap-2 text-sm text-gray-300' },
                h('input', {
                  type: 'checkbox',
                  checked: limits.requireHumanDecision,
                  onChange: e => setLimits({ ...limits, requireHumanDecision: e.target.checked }),
                  className: 'accent-primary'
                }),
                'Pause and require human decision when critical blockers are raised'
              )
            )
          ),

          // Step 5: Review & Start
          step === 5 && h('div', null,
            h('h2', { className: 'text-xl font-bold mb-4' }, 'Review & Start'),
            h('div', { className: 'space-y-4 mb-6' },
              h('div', null,
                h('label', { className: 'block text-gray-400 mb-2' }, 'Topic'),
                h('textarea', {
                  value: topic,
                  onChange: e => setTopic(e.target.value),
                  className: 'w-full h-24 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-primary resize-none'
                })
              ),
              h('div', null,
                h('label', { className: 'block text-gray-400 mb-2' }, 'Depth (rounds)'),
                h('div', { className: 'flex items-center gap-4' },
                  h('input', {
                    type: 'range',
                    min: 2,
                    max: 5,
                    value: depth,
                    onChange: e => setDepth(parseInt(e.target.value)),
                    className: 'flex-1'
                  }),
                  h('input', {
                    type: 'number',
                    min: 2,
                    max: 5,
                    value: depth,
                    onChange: e => setDepth(parseInt(e.target.value)),
                    className: 'w-20 px-2 py-1 bg-gray-700 border border-gray-600 rounded-lg text-white text-center'
                  })
                )
              ),
              h('div', null,
                h('label', { className: 'block text-gray-400 mb-2' }, 'Moderator model'),
                h('div', { className: 'flex items-center gap-2' },
                  h('span', { className: 'text-sm text-gray-400' }, selectedProvider + ':'),
                  (providers.find(p => p.id === selectedProvider)?.models?.length || 0) > 0
                    ? h('select', {
                        value: selectedModel,
                        onChange: e => setSelectedModel(e.target.value),
                        className: 'flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-primary'
                      },
                        providers
                          .find(p => p.id === selectedProvider)
                          ?.models?.map(model =>
                            h('option', { key: model, value: model }, model)
                          )
                      )
                    : h('input', {
                        type: 'text',
                        value: selectedModel,
                        onChange: e => setSelectedModel(e.target.value),
                        placeholder: 'Model name',
                        className: 'flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-primary'
                      })
                )
              ),
              h('div', null,
                h('span', { className: 'text-gray-400 block mb-2' }, 'Agents:'),
                h('div', { className: 'space-y-1 pl-4' },
                  agents.map((a, i) => h('div', { key: i, className: 'text-sm' },
                    h('span', { className: 'text-white capitalize' }, a.personality),
                    h('span', { className: 'text-gray-400' }, ' → ' + a.provider + ':' + a.model)
                  ))
                )
              )
            ),
            h('button', {
              onClick: startDiscussion,
              disabled: agents.length < 2 || !topic,
              className: 'w-full py-3 bg-primary hover:bg-primary/80 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-bold transition'
            }, '🚀 Start Discussion')
          ),

          // Navigation
          h('div', { className: 'flex justify-between mt-6 pt-4 border-t border-gray-700' },
            step > 1 
              ? h('button', { onClick: () => setStep(step - 1), className: 'text-gray-400 hover:text-white' }, '← Back')
              : h('div'),
            step < 5 && h('button', {
              onClick: () => setStep(step + 1),
              disabled: (step === 1 && !topic) || (step === 2 && !selectedProvider) || (step === 3 && agents.length < 2),
              className: 'px-6 py-2 bg-primary hover:bg-primary/80 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg transition'
            }, 'Next →')
          )
        )
      )
    );
  }

  // Render discussion
  const statusText = isRunning ? '● Running' : abortReason ? '⚠ Paused' : '✓ Complete';
  const statusClass = isRunning ? 'text-green-400' : abortReason ? 'text-orange-400' : 'text-blue-400';

  return h(Fragment, null,
    h(Header),
    h('main', { className: 'max-w-4xl mx-auto px-6 py-8' },
      // Abort banner
      abortReason && h('div', { className: 'mb-6 p-4 rounded-lg bg-orange-900/30 border border-orange-500' },
        h('div', { className: 'flex items-center gap-2 mb-2' },
          h('span', { className: 'text-lg' }, '⚠️'),
          h('span', { className: 'font-bold text-orange-200' }, 'Discussion paused')
        ),
        h('div', { className: 'text-sm text-orange-100 mb-2' }, formatAbortReason(abortReason)),
        abortReason.type === 'needs_human' && h('div', { className: 'mt-4' },
          h('label', { className: 'block text-xs text-orange-200 mb-2' }, 'Provide a human decision to continue'),
          h('textarea', {
            value: humanDecisionText,
            onChange: e => setHumanDecisionText(e.target.value),
            placeholder: 'Explain how to resolve the critical blockers...',
            className: 'w-full h-24 px-3 py-2 bg-gray-800 border border-orange-500/50 rounded-lg text-white placeholder-gray-500'
          }),
          h('button', {
            onClick: () => handleContinue({
              additionalRounds: 1,
              humanDecision: humanDecisionText,
              resolveBlockers: 'all'
            }),
            disabled: !humanDecisionText.trim() || isContinuing,
            className: 'mt-3 px-4 py-2 bg-orange-500 hover:bg-orange-400 disabled:bg-gray-600 rounded-lg text-sm font-semibold transition'
          }, isContinuing ? 'Continuing...' : 'Apply decision & continue')
        ),
        abortReason.blockers && abortReason.blockers.length > 0 && h('div', { className: 'mt-3' },
          h('div', { className: 'text-xs text-orange-200 mb-2' }, 'Critical blockers to review:'),
          h('div', { className: 'space-y-2' },
            abortReason.blockers.map((b, i) =>
              h('div', { key: i, className: 'p-3 bg-orange-900/40 border border-orange-500/40 rounded-lg' },
                h('div', { className: 'flex items-center gap-2 mb-1' },
                  h('span', { className: 'text-xs bg-orange-500/30 px-2 py-0.5 rounded' },
                    'Severity ' + b.severity + '/5'
                  ),
                  h('span', { className: 'text-xs bg-gray-600 px-2 py-0.5 rounded' },
                    'Confidence ' + b.confidence + '/5'
                  )
                ),
                h('div', { className: 'text-sm text-white' }, b.condition),
                h('div', { className: 'text-xs text-gray-300 mt-1' }, 'Mitigation: ' + b.mitigation)
              )
            )
          )
        ),
        h('div', { className: 'mt-4 flex gap-3' },
          h('button', {
            onClick: () => { setView('wizard'); setStep(1); setMessages([]); setAbortReason(null); },
            className: 'px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition text-sm'
          }, 'Back to Wizard'),
          h('button', {
            onClick: () => handleContinue({
              additionalRounds: 1,
              overrideLimits: {
                maxBlockers: Math.max(limits.maxBlockers || 20, 20) + 10,
                requireHumanDecision: false
              }
            }),
            disabled: isContinuing,
            className: 'px-4 py-2 bg-primary hover:bg-primary/80 rounded-lg transition text-sm'
          }, isContinuing ? 'Continuing...' : 'Continue anyway'),
          sessionId && h('a', {
            href: '/api/sessions/' + sessionId + '/export',
            className: 'px-4 py-2 bg-primary hover:bg-primary/80 rounded-lg transition text-sm text-center'
          }, 'Export Markdown')
        )
      ),
      // Status bar
      h('div', { className: 'flex items-center justify-between mb-6 p-4 bg-gray-800 rounded-lg flex-wrap gap-4' },
        h('div', null,
          h('div', { className: 'text-sm text-gray-400' }, 'Phase'),
          h('div', { className: 'font-bold text-yellow-400' }, currentPhase || 'Starting...')
        ),
        h('div', null,
          h('div', { className: 'text-sm text-gray-400' }, 'Round'),
          h('div', { className: 'font-bold' }, currentRound + ' / ' + depth)
        ),
        h('div', null,
          h('div', { className: 'text-sm text-gray-400' }, 'Cost'),
          h('div', { className: 'font-bold text-green-400' }, 
            '$' + totalCost.toFixed(4) + ' (' + totalTokens.toLocaleString() + ' tokens)'
          )
        ),
        h('div', null,
          h('div', { className: 'text-sm text-gray-400' }, 'Blockers'),
          h('div', { className: 'font-bold ' + (blockers.filter(b => b.status === 'open').length > 0 ? 'text-orange-400' : 'text-gray-400') },
            blockers.filter(b => b.status === 'open').length + ' open'
          )
        ),
        h('div', null,
          h('div', { className: 'text-sm text-gray-400' }, 'Status'),
          h('div', { className: 'font-bold ' + statusClass }, statusText)
        )
      ),
      
      // Decision Gate (if available)
      decisionGate && h('div', { 
        className: 'mb-6 p-4 rounded-lg ' + (
          decisionGate.condition === 'go' ? 'bg-green-900/30 border border-green-500' :
          decisionGate.condition === 'no-go' ? 'bg-red-900/30 border border-red-500' :
          decisionGate.condition === 'needs-human' ? 'bg-orange-900/30 border border-orange-500' :
          'bg-yellow-900/30 border border-yellow-500'
        )
      },
        h('div', { className: 'flex items-center gap-2 mb-2' },
          h('span', { className: 'text-lg' }, 
            decisionGate.condition === 'go' ? '✅' : 
            decisionGate.condition === 'no-go' ? '❌' : 
            decisionGate.condition === 'needs-human' ? '👤' : '🔄'
          ),
          h('span', { className: 'font-bold text-white' }, 
            'Decision Gate: ' + decisionGate.condition.toUpperCase()
          )
        ),
        h('div', { className: 'text-sm text-gray-300' }, decisionGate.recommendation),
        h('div', { className: 'text-xs text-gray-400 mt-2' }, 
          'Agreement: ' + decisionGate.metrics.agreementLevel.toFixed(0) + '% | ' +
          'Cost: $' + decisionGate.metrics.costSpent.toFixed(4) + '/$' + decisionGate.metrics.costLimit.toFixed(2)
        )
      ),
      
      // Open Blockers (if any)
      blockers.filter(b => b.status === 'open').length > 0 && h('div', { className: 'mb-6' },
        h('div', { className: 'text-sm text-gray-400 mb-2' }, '⚠️ Open Blockers'),
        h('div', { className: 'space-y-2' },
          blockers.filter(b => b.status === 'open').map((b, i) => 
            h('div', { key: i, className: 'p-3 bg-orange-900/20 border border-orange-500/30 rounded-lg' },
              h('div', { className: 'flex items-center gap-2 mb-1' },
                h('span', { className: 'text-xs bg-orange-500/30 px-2 py-0.5 rounded' }, 
                  'Severity ' + b.severity + '/5'
                ),
                h('span', { className: 'text-xs bg-gray-600 px-2 py-0.5 rounded' }, 
                  'Confidence ' + b.confidence + '/5'
                )
              ),
              h('div', { className: 'text-sm text-white' }, b.condition),
              h('div', { className: 'text-xs text-gray-400 mt-1' }, 'Impact: ' + b.impact)
            )
          )
        )
      ),

      // Topic
      h('div', { className: 'mb-6 p-4 bg-gray-800 rounded-lg' },
        h('div', { className: 'text-sm text-gray-400 mb-1' }, 'Topic'),
        h('div', { className: 'text-lg' }, topic)
      ),

      // Messages
      h('div', { className: 'space-y-4 mb-4' },
        messages.map((msg, i) => h(MessageBubble, { key: i, message: msg }))
      ),

      // Streaming message
      currentSpeaker && h('div', { className: 'p-4 rounded-lg bg-gray-800 border-2 border-primary animate-pulse-slow' },
        h('div', { className: 'flex items-center gap-2 mb-2' },
          h('span', { className: 'animate-spin' }, '◐'),
          h('span', { className: 'font-bold text-primary' }, currentSpeaker)
        ),
        h('div', { className: 'text-gray-300' }, streamingContent || 'Thinking...')
      ),

      // Actions
      !isRunning && sessionId && h('div', { className: 'mt-6 flex gap-4' },
        h('button', {
          onClick: () => { setView('wizard'); setStep(1); setMessages([]); setAbortReason(null); },
          className: 'flex-1 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition'
        }, 'New Discussion'),
        h('a', {
          href: '/api/sessions/' + sessionId + '/export',
          className: 'flex-1 py-3 bg-primary hover:bg-primary/80 rounded-lg text-center transition'
        }, '📄 Export Markdown')
      )
    )
  );
}

// Mount
createRoot(document.getElementById('root')).render(h(App));
`;

app.get('/', (c) => c.html(frontendHtml));
app.get('/app.js', (c) => {
  return c.text(frontendJs, 200, {
    'Content-Type': 'application/javascript',
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

export async function startServer(port: number = 3000, workspacePath?: string): Promise<void> {
  // Initialize workspace
  currentWorkspace = new WorkspaceManager(workspacePath);
  await currentWorkspace.init();
  await currentWorkspace.applyApiKeys();

  // Enable logging
  logger.configure({ level: 'info', file: true, console: false });
  logger.info('WebServer', `Starting server on port ${port}`, { workspace: currentWorkspace.getPath() });

  console.log(`
╔════════════════════════════════════════════════╗
║         🤖 Bot Consensus Web UI                ║
╠════════════════════════════════════════════════╣
║  Server running at: http://localhost:${port}      ║
║  Workspace: ${(currentWorkspace.getPath()).slice(0, 30).padEnd(30)}║
║  Press Ctrl+C to stop                          ║
╚════════════════════════════════════════════════╝
`);

  const server = Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 255, // Max timeout (255 seconds) for long-running SSE streams
  });

  // Keep the process running
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    logger.info('WebServer', 'Server shutting down');
    server.stop();
    process.exit(0);
  });
}

// Direct execution
if (import.meta.main) {
  const port = parseInt(process.env.WEB_PORT || '3000');
  startServer(port);
}

export default app;
