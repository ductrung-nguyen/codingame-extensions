# Development Guide - CodinGame VS Code Extension

This guide covers development setup, architecture patterns, and contribution guidelines for the CodinGame VS Code extension.

## Quick Start

### Prerequisites
- Node.js 18+ and npm
- Visual Studio Code 1.80.0+
- TypeScript 5.1+
- Git

### Initial Setup

```bash
# Clone repository
git clone <repository-url>
cd chrome-extention/vscode-extension

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch
```

### Running in Development

1. **Open Extension Project:**
   ```bash
   code .
   ```

2. **Start Debug Session:**
   - Press `F5` or select `Run > Start Debugging`
   - A new "Extension Development Host" window opens
   - Your extension is loaded in the new window

3. **Test Commands:**
   - Open Command Palette (`Cmd/Ctrl+Shift+P`)
   - Type "CodinGame" to see available commands
   - Try `CodinGame: Open Logs` to verify activation

4. **View Logs:**
   - In Extension Development Host, open Output panel
   - Select "CodinGame" from dropdown
   - Watch activation and command logs

### Project Structure

```
vscode-extension/
├── src/
│   ├── extension.ts                 # Main entry point
│   ├── services/
│   │   ├── ConfigurationService.ts  # Task 2.1 ✅
│   │   ├── CommentProcessor.ts      # Task 2.2 (TODO)
│   │   ├── BridgeClient.ts          # Task 2.6 (TODO)
│   │   ├── SyncController.ts        # Task 2.3 (TODO)
│   │   ├── MatchStorageService.ts   # Task 2.4 (TODO)
│   │   └── LoggingService.ts        # Shared utility
│   ├── webviews/
│   │   └── StatisticsPanel.ts       # Task 2.5 (TODO)
│   ├── types/
│   │   └── index.ts                 # Shared type definitions
│   └── test/
│       └── suite/
│           └── config.test.ts       # Unit tests
├── package.json                     # Extension manifest
├── tsconfig.json                    # TypeScript config
├── README.md                        # User documentation
└── DEVELOPMENT.md                   # This file
```

## Architecture Patterns

### Service Layer Pattern

All major functionality encapsulated in service classes:

```typescript
export class ServiceName implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  
  constructor(
    private context: vscode.ExtensionContext,
    private outputChannel: vscode.OutputChannel
  ) {
    // Initialize
  }
  
  async initialize(): Promise<void> {
    // Setup logic
  }
  
  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
```

**Benefits:**
- Clean separation of concerns
- Easy to test in isolation
- Proper resource cleanup via `Disposable`

### Event-Driven Communication

Services communicate via VS Code's `EventEmitter`:

```typescript
private changeEmitter = new vscode.EventEmitter<ChangeEvent>();
public readonly onChange = this.changeEmitter.event;

// Fire event
this.changeEmitter.fire({ type: 'update', data: {} });

// Subscribe in another service
configService.onChange(event => {
  // React to configuration changes
});
```

### Async-First Design

All I/O operations use async/await:

```typescript
// Good
async function readConfig(): Promise<Config> {
  const data = await fs.readFile('config.json', 'utf-8');
  return JSON.parse(data);
}

// Bad - blocks event loop
function readConfigSync(): Config {
  const data = fs.readFileSync('config.json', 'utf-8');
  return JSON.parse(data);
}
```

### Error Handling Strategy

Three-tier approach:

```typescript
// 1. Silent recovery (log only)
try {
  const optional = await loadOptionalData();
} catch (error) {
  this.log(`Optional load failed: ${error}`);
  // Continue with defaults
}

// 2. User notification (recoverable)
try {
  await validateDirectory();
} catch (error) {
  const choice = await vscode.window.showWarningMessage(
    'Directory invalid',
    'Fix', 'Cancel'
  );
  // Handle user choice
}

// 3. Activation failure (critical)
try {
  await criticalSetup();
} catch (error) {
  vscode.window.showErrorMessage(`Fatal error: ${error}`);
  throw error; // Prevent extension load
}
```

## Implementation Guidelines

### Task Implementation Workflow

1. **Read BDD Spec:**
   - Review scenarios in `specs/implementation-plan-bdd.md`
   - Understand acceptance criteria

2. **Create Service Class:**
   - Follow existing patterns (see `ConfigurationService.ts`)
   - Implement `initialize()` and `dispose()`
   - Add to `extension.ts` activation

3. **Write Tests:**
   - Create test file in `src/test/suite/`
   - Cover all BDD scenarios
   - Add edge cases

4. **Document Implementation:**
   - Update `docs.md` with technical details
   - Include code samples and diagrams
   - Document known limitations

5. **Manual QA:**
   - Test in Extension Development Host
   - Verify all scenarios pass
   - Test error conditions

### Code Style

**TypeScript Conventions:**
```typescript
// Use explicit types
function processData(input: string): Result {
  return { status: 'ok', data: input };
}

// Prefer interfaces for public APIs
export interface ConfigChangeEvent {
  stripComments: boolean;
  targetFile: boolean;
}

// Use readonly where appropriate
class Service {
  public readonly onEvent: vscode.Event<EventData>;
}

// Destructure for clarity
const { stripComments, targetFile } = config;
```

**Naming Conventions:**
- Classes: PascalCase (`ConfigurationService`)
- Methods: camelCase (`getMatchesDirectory`)
- Constants: UPPER_SNAKE_CASE (`DEFAULT_PORT`)
- Private fields: prefix with underscore (`_cache`)
- Interfaces: PascalCase, suffix with noun (`ConfigChangeEvent`)

**File Organization:**
- One class per file (except small helpers)
- Exports at bottom of file
- Imports grouped: stdlib, vscode, local
- Type definitions in separate `types/` directory

### Logging Best Practices

```typescript
// Use consistent prefixes
this.log('[CONFIG] Initializing...');
this.log('[SYNC] Sending payload...');
this.log('[MATCH] Storing result...');

// Include context in messages
this.log(`[CONFIG] Directory created: ${path}`);
this.log(`[SYNC] Request ${requestId} completed`);

// Log errors with stack traces
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  this.log(`[ERROR] Failed: ${message}`, true);
  if (this.isVerbose() && error instanceof Error) {
    this.log(error.stack || '');
  }
}

// Use verbose flag for debug details
if (this.configService.isVerboseLogging()) {
  this.log(`[DEBUG] State: ${JSON.stringify(state)}`);
}
```

## Testing

### Running Tests

```bash
# Compile and run all tests
npm test

# Watch mode for TDD
npm run watch & npm test -- --watch

# Run specific test suite
npm test -- --grep "ConfigurationService"
```

### Writing Unit Tests

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConfigurationService } from '../../services/ConfigurationService';

suite('ConfigurationService Test Suite', () => {
  let service: ConfigurationService;
  
  setup(async () => {
    // Initialize before each test
    const context = {} as vscode.ExtensionContext;
    const outputChannel = vscode.window.createOutputChannel('Test');
    service = new ConfigurationService(context, outputChannel);
    await service.initialize();
  });
  
  teardown(() => {
    service.dispose();
  });
  
  test('Should create default directory', async () => {
    const dir = service.getMatchesDirectory();
    assert.ok(dir.endsWith('.codingame/matches'));
  });
  
  test('Should validate bridge host', () => {
    const host = service.getBridgeHost();
    assert.strictEqual(host, '127.0.0.1');
  });
});
```

### Integration Testing Strategy

```typescript
// Mock VS Code workspace
const workspaceFolder = {
  uri: vscode.Uri.file('/test/workspace'),
  name: 'test',
  index: 0
};

// Mock configuration
const mockConfig = {
  get: (key: string, defaultValue: any) => defaultValue,
  update: async (key: string, value: any) => {}
};
```

## Debugging

### VS Code Debugger

**Launch Configuration (`.vscode/launch.json`):**
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}"
      ],
      "outFiles": [
        "${workspaceFolder}/out/**/*.js"
      ],
      "preLaunchTask": "npm: compile"
    }
  ]
}
```

**Breakpoint Tips:**
- Set breakpoints in `.ts` files (source maps enabled)
- Use "Debug Console" for expression evaluation
- Inspect `context`, `outputChannel` in variables panel

### Common Issues

**Extension Not Activating:**
```bash
# Check activation events in package.json
"activationEvents": ["onStartupFinished"]

# Verify compilation
npm run compile

# Check for errors in Debug Console
```

**Commands Not Registered:**
```typescript
// Ensure commands registered in activate()
context.subscriptions.push(
  vscode.commands.registerCommand('codingame.sync', handler)
);

// Verify command ID matches package.json
"commands": [{ "command": "codingame.sync", ... }]
```

**Configuration Not Persisting:**
```typescript
// Use correct configuration target
await config.update(
  'matches.directory',
  value,
  vscode.ConfigurationTarget.Workspace  // Not Global
);
```

## Performance Optimization

### Profiling

```typescript
// Measure operation timing
const start = Date.now();
await expensiveOperation();
const duration = Date.now() - start;
this.log(`[PERF] Operation took ${duration}ms`);
```

### Best Practices

1. **Lazy Loading:**
   ```typescript
   private _webview?: vscode.WebviewPanel;
   
   get webview(): vscode.WebviewPanel {
     if (!this._webview) {
       this._webview = this.createWebview();
     }
     return this._webview;
   }
   ```

2. **Debouncing:**
   ```typescript
   private configChangeTimeout?: NodeJS.Timeout;
   
   private onConfigChange() {
     clearTimeout(this.configChangeTimeout);
     this.configChangeTimeout = setTimeout(() => {
       this.reloadConfig();
     }, 300);
   }
   ```

3. **Caching:**
   ```typescript
   private matchCache = new Map<string, MatchData>();
   
   async getMatch(id: string): Promise<MatchData> {
     if (this.matchCache.has(id)) {
       return this.matchCache.get(id)!;
     }
     const match = await this.loadMatch(id);
     this.matchCache.set(id, match);
     return match;
   }
   ```

## Contributing

### Pull Request Process

1. **Create Feature Branch:**
   ```bash
   git checkout -b task-2.2-comment-processor
   ```

2. **Implement with Tests:**
   - Write failing tests first (TDD)
   - Implement until tests pass
   - Refactor for clarity

3. **Update Documentation:**
   - Add section to `docs.md`
   - Update README if user-facing
   - Include code examples

4. **Commit with Convention:**
   ```bash
   git commit -m "feat(task-2.2): implement comment processor service
   
   - Add AST-based stripping for Python, JS, C++
   - Include regex fallback for unsupported languages
   - Cover all BDD scenarios with tests"
   ```

5. **Push and Create PR:**
   ```bash
   git push origin task-2.2-comment-processor
   # Create PR on GitHub with description and screenshots
   ```

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `test`: Adding tests
- `refactor`: Code restructure without behavior change
- `perf`: Performance improvement
- `chore`: Maintenance tasks

**Examples:**
```
feat(config): add configuration validation on startup
fix(sync): handle editor not ready scenario correctly
docs(task-2.1): add technical implementation details
test(config): add integration tests for directory handling
```

## Release Process

### Version Bumping

```bash
# Update version in package.json
npm version patch  # 0.1.0 -> 0.1.1
npm version minor  # 0.1.0 -> 0.2.0
npm version major  # 0.1.0 -> 1.0.0
```

### Packaging

```bash
# Install VSCE (once)
npm install -g @vscode/vsce

# Create .vsix package
vsce package

# Result: codingame-vscode-extension-0.1.0.vsix
```

### Testing Release

```bash
# Install locally
code --install-extension codingame-vscode-extension-0.1.0.vsix

# Test in fresh workspace
mkdir test-workspace
cd test-workspace
code .
```

## Resources

### Official Documentation
- [VS Code Extension API](https://code.visualstudio.com/api)
- [Extension Guides](https://code.visualstudio.com/api/extension-guides/overview)
- [Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)


### Tools
- [Extension Generator](https://www.npmjs.com/package/yo)
- [VSCE Publishing Tool](https://github.com/microsoft/vscode-vsce)
- [Extension Samples](https://github.com/microsoft/vscode-extension-samples)

## FAQ

**Q: Why TypeScript instead of JavaScript?**  
A: Type safety catches errors at compile time, improves IDE support, and makes refactoring safer.

**Q: How do I test WebSocket communication with Chrome extension?**  
A: Mock the WebSocket in tests, or use a test harness that simulates Chrome extension messages.

**Q: Can I use external npm packages?**  
A: Yes, but keep bundle size small. Avoid packages with native dependencies when possible.

**Q: How do I debug the webview?**  
A: Right-click in webview → "Open Webview Developer Tools" to access Chrome DevTools.

**Q: What's the maximum extension size?**  
A: VS Code Marketplace recommends < 50 MB. Our extension should stay well under 5 MB.

---

For questions or issues, consult the [main documentation](../docs.md) or open an issue on GitHub.
