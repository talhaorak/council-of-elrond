/**
 * Interrupt and display control for consensus discussions
 */

export type InterruptType = 'none' | 'soft' | 'hard';

export interface InterruptController {
  /** Current interrupt state */
  readonly state: InterruptType;
  /** Whether verbose (streaming) output is enabled */
  readonly verbose: boolean;
  /** Whether skip current agent is requested */
  readonly skipRequested: boolean;
  /** Request a soft interrupt (wrap up gracefully) */
  softInterrupt(): void;
  /** Request a hard interrupt (stop immediately) */
  hardInterrupt(): void;
  /** Toggle verbose output mode */
  toggleVerbose(): void;
  /** Set verbose mode directly */
  setVerbose(value: boolean): void;
  /** Skip/pass the current agent's turn */
  skipCurrentAgent(): void;
  /** Clear skip request (after handling) */
  clearSkip(): void;
  /** Check if any interrupt is requested */
  isInterrupted(): boolean;
  /** Check if soft interrupt is requested */
  isSoftInterrupt(): boolean;
  /** Check if hard interrupt is requested */
  isHardInterrupt(): boolean;
  /** Reset interrupt state */
  reset(): void;
  /** Set up keyboard listeners (for CLI/TUI) */
  setupKeyboardListeners(options?: { showHelp?: boolean }): () => void;
}

/**
 * Create an interrupt controller
 */
export function createInterruptController(initialVerbose: boolean = true): InterruptController {
  let state: InterruptType = 'none';
  let verbose: boolean = initialVerbose;
  let skipRequested: boolean = false;
  let cleanupFn: (() => void) | null = null;

  return {
    get state() {
      return state;
    },

    get verbose() {
      return verbose;
    },

    get skipRequested() {
      return skipRequested;
    },

    softInterrupt() {
      if (state === 'none') {
        state = 'soft';
        console.log('\n⚡ Soft interrupt requested - wrapping up discussion...\n');
      }
    },

    hardInterrupt() {
      state = 'hard';
      console.log('\n🛑 Hard interrupt - stopping immediately...\n');
    },

    toggleVerbose() {
      verbose = !verbose;
      console.log(verbose 
        ? '\n📢 Verbose mode ON - showing full responses\n' 
        : '\n🔇 Verbose mode OFF - showing summaries only\n'
      );
    },

    setVerbose(value: boolean) {
      verbose = value;
    },

    skipCurrentAgent() {
      skipRequested = true;
      console.log('\n⏭️  Skip requested - passing current agent\'s turn...\n');
    },

    clearSkip() {
      skipRequested = false;
    },

    isInterrupted() {
      return state !== 'none';
    },

    isSoftInterrupt() {
      return state === 'soft';
    },

    isHardInterrupt() {
      return state === 'hard';
    },

    reset() {
      state = 'none';
      skipRequested = false;
    },

    setupKeyboardListeners(options?: { showHelp?: boolean }) {
      // Set up stdin for raw mode if in TTY
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (key: string) => {
          // Ctrl+C - hard interrupt
          if (key === '\u0003') {
            this.hardInterrupt();
          }
          // 's' or 'S' - soft interrupt
          else if (key === 's' || key === 'S') {
            this.softInterrupt();
          }
          // 'q' or 'Q' - also hard interrupt (quit)
          else if (key === 'q' || key === 'Q') {
            this.hardInterrupt();
          }
          // 'v' or 'V' - toggle verbose mode
          else if (key === 'v' || key === 'V') {
            this.toggleVerbose();
          }
          // 'p' or 'P' or space - skip/pass current agent
          else if (key === 'p' || key === 'P' || key === ' ') {
            this.skipCurrentAgent();
          }
          // 'h' or 'H' or '?' - show help
          else if ((key === 'h' || key === 'H' || key === '?') && options?.showHelp !== false) {
            console.log('\n' + '─'.repeat(50));
            console.log('  Keyboard Controls:');
            console.log('    v - Toggle verbose/quiet mode');
            console.log('    p - Skip/pass current agent');
            console.log('    s - Soft interrupt (wrap up)');
            console.log('    q - Quit (hard interrupt)');
            console.log('    h - Show this help');
            console.log('─'.repeat(50) + '\n');
          }
        };

        process.stdin.on('data', onData);

        cleanupFn = () => {
          process.stdin.removeListener('data', onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          process.stdin.pause();
        };

        // Also handle SIGINT
        const onSigint = () => {
          this.hardInterrupt();
        };
        process.on('SIGINT', onSigint);

        return () => {
          cleanupFn?.();
          process.removeListener('SIGINT', onSigint);
        };
      }

      // Non-TTY: just handle SIGINT
      const onSigint = () => {
        this.hardInterrupt();
      };
      process.on('SIGINT', onSigint);

      return () => {
        process.removeListener('SIGINT', onSigint);
      };
    },
  };
}

/**
 * Global interrupt controller for the application
 */
export const globalInterruptController = createInterruptController();
