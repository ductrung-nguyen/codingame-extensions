# CodinGame VS Code Extension

Synchronize local CodinGame bot code with the browser and visualize match telemetry.

## Features

### 🔄 Code Synchronization
- Sync your local code directly to the CodinGame browser editor
- **Intelligent comment stripping** with AST-based processing
  - Python, JavaScript, TypeScript, C++, Java support
  - Regex fallback for other languages
  - Newline preservation for accurate stack traces
- Support for multiple programming languages
- Real-time sync status feedback with processing statistics

### 📊 Match Statistics
- Automatic capture of match results from the browser
- Detailed statistics dashboard with win rates and performance metrics
- Filter and search through match history
- Quick access to replay URLs

### ⚙️ Configuration Management
- Automatic setup of match storage directory
- Flexible configuration options
- Workspace-specific settings support

## Requirements

- Visual Studio Code 1.80.0 or higher
- CodinGame Chrome Extension installed and running
- Active CodinGame account

## Installation

1. Install the extension from the VS Code Marketplace (coming soon) or build from source
2. Install the companion Chrome extension
3. Open a workspace folder in VS Code
4. The extension will automatically create `.codingame/matches` directory on first activation
5. Optionally enable comment stripping via `CodinGame: Toggle Strip Comments`

## Quick Start

1. **Open Command Palette** (`Cmd/Ctrl + Shift + P`)
2. **Run** `CodinGame: Sync Code to Browser`
3. The extension will connect to the Chrome extension and sync your code
4. Play matches on CodinGame - results are automatically saved
5. **View Statistics** with `CodinGame: Show Statistics`

## Commands

Access these commands via the Command Palette (`Cmd/Ctrl + Shift + P`):

| Command | Description |
|---------|-------------|
| `CodinGame: Sync Code to Browser` | Synchronize current file to CodinGame editor |
| `CodinGame: Toggle Strip Comments` | Enable/disable comment removal before sync |
| `CodinGame: Test Comment Stripping (Demo)` | Preview comment stripping in side-by-side view |
| `CodinGame: Show Statistics` | Open match statistics dashboard |
| `CodinGame: Configure Storage Directory` | Change where match data is stored |
| `CodinGame: Open Logs` | View extension logs for debugging |
| `CodinGame: Resend Last Code Snapshot` | Retry the last sync operation |
| `CodinGame: Retry Failed Matches` | Reprocess failed match saves |

## Configuration

Configure the extension via VS Code settings (`Cmd/Ctrl + ,` and search for "CodinGame"):

### Code Synchronization Settings

```json
{
  // Strip comments before syncing (default: false)
  "codingame.sync.stripComments": false,
  
  // Comment stripping strategy: auto, regex, or none (default: auto)
  "codingame.sync.commentStrategy": "auto",
  
  // Specific file to sync (empty = active editor)
  "codingame.sync.targetFile": "",
  
  // Advanced: Test comment stripping before syncing
  // Run: CodinGame: Test Comment Stripping (Demo)
}
```

### Match Storage Settings

```json
{
  // Directory for match data relative to workspace (default: .codingame/matches)
  "codingame.matches.directory": ".codingame/matches",
  
  // Maximum match files to keep, 0 = unlimited (default: 1000)
  "codingame.matches.maxFiles": 1000
}
```

### Bridge Communication Settings

```json
{
  // WebSocket port for Chrome extension communication (default: 45123)
  "codingame.bridge.port": 45123,
  
  // WebSocket host - should remain localhost for security (default: 127.0.0.1)
  "codingame.bridge.host": "127.0.0.1",
  
  // Enable verbose logging for debugging (default: false)
  "codingame.logging.verbose": false
}
```

## Architecture

The extension consists of several key components:

### Configuration Service (Task 2.1) ✅
- Validates and manages extension settings
- Creates default directories on first run
- Emits events when configuration changes
- Handles invalid directory scenarios with user prompts

### Comment Processing Service (Task 2.2) ✅
- **AST-based stripping** for Python, JavaScript, TypeScript, C++, Java
- **Regex fallback** for Rust, Ruby, Bash, and other languages
- Preserves newlines to maintain stack trace line numbers
- Status bar indicator with visual warnings
- Processing statistics (bytes reduced, reduction percentage)
- Multi-strategy support: auto, regex, none

### Services (Coming Soon)
- **Comment Processing Service** (Task 2.2): Language-aware comment stripping
- **Bridge Client** (Task 2.6): WebSocket communication with Chrome extension
- **Sync Controller** (Task 2.3): Orchestrates code synchronization
- **Match Storage Service** (Task 2.4): Persists and indexes match data
- **Statistics Webview** (Task 2.5): Visualizes match performance

## Directory Structure

```
.codingame/
└── matches/          # Match data storage
    ├── WIN_0_1001.json
    ├── LOSE_1_1002.json
    └── ...
```

Each match file follows the naming convention: `<RESULT>_<ORDER>_<MATCH_ID>.json`

## Comment Stripping

### How It Works

The extension provides intelligent comment removal to reduce code size for CodinGame submissions:

1. **AST-Based Processing (Preferred):**
   - Python: Removes `#` comments, preserves docstrings
   - JavaScript/TypeScript: Removes `//` and `/* */` comments
   - C++/C/Java: Removes `//` and `/* */` comments
   - Handles comments inside strings correctly

2. **Regex Fallback:**
   - Used for unsupported languages (Rust, Ruby, etc.)
   - Less accurate but still functional
   - Status bar shows warning indicator

3. **Newline Preservation:**
   - Critical for stack trace accuracy
   - Line numbers remain consistent
   - Debugging unaffected

### Testing Comment Stripping

Use the demo command to preview results:

```
1. Open a code file
2. Run: CodinGame: Test Comment Stripping (Demo)
3. View side-by-side comparison
4. Check statistics in Output panel
```

### Language Support

| Language | Method | Comments Handled |
|----------|--------|------------------|
| Python | AST | `#`, `"""`, `'''` |
| JavaScript/TypeScript | AST | `//`, `/* */` |
| C++/C/Java | AST | `//`, `/* */` |
| C#/Rust | Regex | `//`, `/* */` |
| Ruby/Bash | Regex | `#` |

## Troubleshooting

### Extension won't activate
1. Check VS Code version (must be 1.80.0+)
2. Open Output panel (`View > Output`) and select "CodinGame"
3. Look for error messages in the activation logs

### Chrome extension not connecting
1. Ensure Chrome extension is installed and enabled
2. Check bridge port in settings (default: 45123)
3. Verify no firewall blocking localhost connections
4. Run `CodinGame: Open Logs` to see connection attempts

### Match directory errors
1. Run `CodinGame: Configure Storage Directory` to set a new location
2. Ensure you have write permissions to the workspace folder
3. Check that directory path doesn't contain invalid characters

### Sync not working
1. Verify an editor window is active with code
2. Check connection status in Output logs
3. Try `CodinGame: Resend Last Code Snapshot`
4. Restart both VS Code and Chrome extension

## Development

### Building from Source

```bash
cd vscode-extension
npm install
npm run compile
```

### Running in Development

1. Open the `vscode-extension` folder in VS Code
2. Press `F5` to launch Extension Development Host
3. Test commands in the new window

### Running Tests

```bash
npm test
```

## Implementation Status

### ✅ Completed Tasks
- **Task 2.1**: Configuration Initialization
  - Default directory creation
  - Invalid directory handling
  - Configuration validation
  - Settings persistence

- **Task 2.2**: Comment Stripping Modes
  - AST-based processing for major languages
  - Regex fallback for unsupported languages
  - Status bar integration with warnings
  - Newline preservation
  - Processing statistics

### 🚧 In Progress
- Task 2.3: Sync Command Lifecycle (next)
- Task 2.6: Bridge Resilience & Logging

### 📋 Planned
- Task 2.4: Match Data Storage
- Task 2.5: Statistics Webview Interactions
- Task 2.7: Diagnostic & Recovery Commands

## Security

- Bridge server listens only on loopback interface (127.0.0.1)
- No external network connections
- Match data stored locally in workspace
- No telemetry or data collection

## License

MIT

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## Support

- **Issues**: [GitHub Issues](https://github.com/codingame/vscode-extension/issues)
- **Logs**: Run `CodinGame: Open Logs` in Command Palette

---

**Note**: This extension is in active development.
