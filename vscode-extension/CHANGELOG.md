# Changelog

All notable changes to the CodinGame VS Code Extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial extension structure and configuration
- Configuration Service (Task 2.1)
  - Automatic creation of `.codingame/matches` directory on first run
  - Settings validation with user-friendly error prompts
  - Configuration change event system
  - Support for workspace and global settings
- Comment Processing Service (Task 2.2)
  - AST-based comment stripping for Python, JavaScript, TypeScript, C++, Java
  - Regex fallback for unsupported languages (Rust, Ruby, Bash, etc.)
  - Newline preservation for accurate stack traces
  - Status bar indicator with click-to-toggle functionality
  - Multi-strategy processing (auto, regex, none)
  - Real-time processing statistics
- Command palette integration with 8 commands
  - `CodinGame: Sync Code to Browser` (integrated with comment processor)
  - `CodinGame: Toggle Strip Comments` (functional)
  - `CodinGame: Test Comment Stripping (Demo)` (functional)
  - `CodinGame: Resend Last Code Snapshot` (placeholder)
  - `CodinGame: Show Statistics` (placeholder)
  - `CodinGame: Retry Failed Matches` (placeholder)
  - `CodinGame: Open Logs` (functional)
  - `CodinGame: Configure Storage Directory` (functional)
- Output channel for diagnostic logging with category prefixes
- Welcome message on first activation with quick setup links
- Test samples for BDD validation (Python, JavaScript, C++)
- Comprehensive configuration schema:
  - Sync settings (comment stripping, target file, strategy selection)
  - Match storage settings (directory, max files)
  - Bridge communication settings (port, host)
  - Logging verbosity controls

### Changed
- N/A (initial release)

### Deprecated
- N/A

### Removed
- N/A

### Fixed
- N/A

### Security
- Bridge host restricted to localhost (127.0.0.1) for security
- Port range validation (1024-65535)
- Path validation prevents arbitrary filesystem access

## [0.1.0] - 2024-06-XX (Development)

### Added
- Project initialization
- TypeScript compilation setup
- VS Code extension manifest
- Development documentation
- BDD test scenarios

### Notes
- This is a development release
- Not yet published to VS Code Marketplace
- Chrome extension companion required for full functionality

---

## Roadmap

### v0.2.0 (In Progress)
- **Task 2.2**: Comment Processing Service with AST-based stripping ✅ Complete
- **Task 2.3**: Sync Command Lifecycle with Monaco editor injection 🚧 Next
- **Task 2.6**: Bridge Client for WebSocket communication 🚧 Planned

### v0.3.0 (Planned)
- **Task 2.4**: Match Data Storage Service
- **Task 2.5**: Statistics Webview with filtering and visualization

### v0.4.0 (Planned)
- **Task 2.7**: Diagnostic & Recovery Commands
- End-to-end integration testing
- Performance optimizations

### v1.0.0 (Future)
- Public release to VS Code Marketplace
- Full feature parity with specification
- Comprehensive documentation and tutorials

---

## Implementation Status

| Task | Status | Version |
|------|--------|---------|
| 2.1 Configuration Initialization | ✅ Complete | 0.1.0 |
| 2.2 Comment Stripping Modes | ✅ Complete | 0.2.0 |
| 2.3 Sync Command Lifecycle | 🚧 Next | 0.2.0 |
| 2.4 Match Data Storage | 🚧 Planned | 0.3.0 |
| 2.5 Statistics Webview | 🚧 Planned | 0.3.0 |
| 2.6 Bridge Resilience & Logging | 🚧 Planned | 0.2.0 |
| 2.7 Diagnostic & Recovery | 🚧 Planned | 0.4.0 |

---
