import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Configuration Service
 *
 * Manages VS Code configuration for CodinGame extension, validates directories,
 * and emits events on configuration changes.
 *
 * Task 2.1: Configuration Initialization
 */
export class ConfigurationService implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private configChangeEmitter = new vscode.EventEmitter<ConfigChangeEvent>();
  private outputChannel: vscode.OutputChannel;

  public readonly onConfigChange = this.configChangeEmitter.event;

  constructor(
    private context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;

    // Watch for configuration changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('codingame')) {
          this.handleConfigChange(e);
        }
      })
    );

    this.disposables.push(this.configChangeEmitter);
  }

  /**
   * Initialize configuration on extension activation
   * Validates directories and creates defaults if needed
   */
  async initialize(): Promise<void> {
    this.log('[CONFIG] Initializing configuration service...');

    try {
      // Validate and create matches directory
      await this.ensureMatchesDirectory();

      // Validate other settings
      await this.validateConfiguration();

      this.log('[CONFIG] Configuration initialized successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[CONFIG] Initialization error: ${message}`, true);
      throw error;
    }
  }

  /**
   * Ensure matches directory exists, create if missing
   * Scenario: "Default Configuration Creation"
   */
  private async ensureMatchesDirectory(): Promise<void> {
    const workspaceFolder = this.getWorkspaceFolder();
    if (!workspaceFolder) {
      this.log('[CONFIG] No workspace folder found, skipping directory creation');
      return;
    }

    const matchesDir = this.getMatchesDirectory();

    try {
      // Check if directory exists
      await fs.access(matchesDir);
      this.log(`[CONFIG] Matches directory exists: ${matchesDir}`);
    } catch {
      // Directory doesn't exist, create it
      try {
        await fs.mkdir(matchesDir, { recursive: true });
        this.log(`[CONFIG] Created matches directory: ${matchesDir}`);

        // Store path in global state
        await this.context.globalState.update('codingame.matchesDirectory', matchesDir);

        vscode.window.showInformationMessage(
          `CodinGame: Created matches directory at ${path.relative(workspaceFolder.uri.fsPath, matchesDir)}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[CONFIG] Failed to create matches directory: ${message}`, true);
        throw new Error(`Failed to create matches directory: ${message}`);
      }
    }
  }

  /**
   * Validate all configuration settings
   */
  private async validateConfiguration(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codingame');

    // Validate bridge host (security)
    const host = config.get<string>('bridge.host', '127.0.0.1');
    if (host !== '127.0.0.1' && host !== 'localhost') {
      vscode.window.showWarningMessage(
        `CodinGame: Bridge host "${host}" is not localhost. This may be a security risk.`
      );
    }

    // Validate port range
    const port = config.get<number>('bridge.port', 45123);
    if (port < 1024 || port > 65535) {
      vscode.window.showWarningMessage(
        `CodinGame: Bridge port ${port} is outside valid range (1024-65535). Using default 45123.`
      );
    }

    // Validate max files
    const maxFiles = config.get<number>('matches.maxFiles', 1000);
    if (maxFiles < 0) {
      vscode.window.showWarningMessage(
        `CodinGame: Invalid maxFiles value (${maxFiles}). Must be >= 0.`
      );
    }
  }

  /**
   * Handle configuration changes
   */
  private async handleConfigChange(e: vscode.ConfigurationChangeEvent): Promise<void> {
    // Fire individual events for each changed key
    const keys = [
      'sync.stripComments',
      'sync.commentStrategy',
      'sync.targetFile',
      'matches.directory',
      'matches.rotation.enabled',
      'matches.rotation.maxMatches',
      'matches.rotation.maxAgeDays',
      'matches.rotation.strategy',
      'matches.autoReindex',
      'bridge.port',
      'bridge.host',
      'logging.verbose'
    ];

    for (const key of keys) {
      if (e.affectsConfiguration(`codingame.${key}`)) {
        const config = vscode.workspace.getConfiguration('codingame');
        const fullKey = `codingame.${key}`;

        this.configChangeEmitter.fire({
          key: fullKey,
          oldValue: undefined, // VS Code doesn't provide old values
          newValue: config.get(key),
          scope: vscode.ConfigurationTarget.Workspace
        });

        this.log(`[CONFIG] Configuration changed: ${fullKey}`);
      }
    }

    // If matches directory changed, validate the new path
    if (e.affectsConfiguration('codingame.matches.directory')) {
      await this.handleMatchesDirectoryChange();
    }
  }

  /**
   * Handle changes to matches directory setting
   * Scenario: "Invalid Directory Handling"
   */
  private async handleMatchesDirectoryChange(): Promise<void> {
    const newDir = this.getMatchesDirectory();

    try {
      // Try to access or create the directory
      await fs.access(newDir);
    } catch {
      // Directory doesn't exist, prompt user
      const choice = await vscode.window.showWarningMessage(
        `CodinGame: Matches directory "${newDir}" does not exist.`,
        'Create Directory',
        'Choose Different Location'
      );

      if (choice === 'Create Directory') {
        try {
          await fs.mkdir(newDir, { recursive: true });
          this.log(`[CONFIG] Created new matches directory: ${newDir}`);
          vscode.window.showInformationMessage('CodinGame: Directory created successfully');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`[CONFIG] Failed to create directory: ${message}`, true);
          await this.promptForMatchesDirectory();
        }
      } else if (choice === 'Choose Different Location') {
        await this.promptForMatchesDirectory();
      }
    }
  }

  /**
   * Prompt user to select a new matches directory
   */
  private async promptForMatchesDirectory(): Promise<void> {
    const workspaceFolder = this.getWorkspaceFolder();
    const defaultUri = workspaceFolder?.uri;

    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri,
      openLabel: 'Select Matches Directory',
      title: 'CodinGame: Choose Matches Storage Directory'
    });

    if (selected && selected[0]) {
      const relativePath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, selected[0].fsPath)
        : selected[0].fsPath;

      const config = vscode.workspace.getConfiguration('codingame');
      await config.update('matches.directory', relativePath, vscode.ConfigurationTarget.Workspace);

      this.log(`[CONFIG] Matches directory updated to: ${relativePath}`);
      vscode.window.showInformationMessage(`CodinGame: Matches directory set to ${relativePath}`);
    }
  }

  // Getters for configuration values

  getStripComments(): boolean {
    return vscode.workspace.getConfiguration('codingame').get('sync.stripComments', false);
  }

  getCommentStrategy(): 'auto' | 'regex' | 'none' {
    return vscode.workspace.getConfiguration('codingame').get('sync.commentStrategy', 'auto');
  }

  getTargetFile(): string {
    return vscode.workspace.getConfiguration('codingame').get('sync.targetFile', '');
  }

  getMatchesDirectory(): string {
    const config = vscode.workspace.getConfiguration('codingame');
    const relativeDir = config.get('matches.directory', '.codingame/matches');

    const workspaceFolder = this.getWorkspaceFolder();
    if (workspaceFolder) {
      return path.join(workspaceFolder.uri.fsPath, relativeDir);
    }

    // Fallback to temp directory if no workspace
    return path.join(this.context.globalStorageUri.fsPath, 'matches');
  }

  getMaxFiles(): number {
    return vscode.workspace.getConfiguration('codingame').get('matches.maxFiles', 1000);
  }

  /**
   * Generic getter for any configuration value
   */
  get<T>(key: string, defaultValue?: T): T {
    const config = vscode.workspace.getConfiguration('codingame');
    if (defaultValue !== undefined) {
      return config.get<T>(key, defaultValue);
    }
    return config.get<T>(key) as T;
  }

  getBridgePort(): number {
    return vscode.workspace.getConfiguration('codingame').get('bridge.port', 45123);
  }

  getBridgeHost(): string {
    return vscode.workspace.getConfiguration('codingame').get('bridge.host', '127.0.0.1');
  }

  isVerboseLogging(): boolean {
    return vscode.workspace.getConfiguration('codingame').get('logging.verbose', false);
  }

  /**
   * Get current workspace folder
   */
  private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0] : undefined;
  }

  /**
   * Log message to output channel
   */
  private log(message: string, isError: boolean = false): void {
    const timestamp = new Date().toISOString();
    const prefix = isError ? '[ERROR]' : '[INFO]';
    this.outputChannel.appendLine(`${timestamp} ${prefix} ${message}`);
  }

  /**
   * Update configuration programmatically
   */
  async updateConfig(
    section: string,
    value: any,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('codingame');
    await config.update(section, value, target);
  }

  /**
   * Get all configuration as object (for debugging)
   */
  getAllConfig(): Record<string, any> {
    const config = vscode.workspace.getConfiguration('codingame');
    return {
      sync: {
        stripComments: config.get('sync.stripComments'),
        commentStrategy: config.get('sync.commentStrategy'),
        targetFile: config.get('sync.targetFile'),
      },
      matches: {
        directory: config.get('matches.directory'),
        maxFiles: config.get('matches.maxFiles'),
      },
      bridge: {
        port: config.get('bridge.port'),
        host: config.get('bridge.host'),
      },
      logging: {
        verbose: config.get('logging.verbose'),
      },
    };
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

/**
 * Event emitted when configuration changes
 */
export interface ConfigChangeEvent {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  scope: vscode.ConfigurationTarget;
}

/**
 * Legacy config change event (deprecated)
 */
export interface LegacyConfigChangeEvent {
  stripComments: boolean;
  commentStrategy: boolean;
  targetFile: boolean;
  matchesDirectory: boolean;
  bridgePort: boolean;
  bridgeHost: boolean;
}
