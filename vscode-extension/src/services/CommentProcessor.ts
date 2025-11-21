import * as vscode from 'vscode';

/**
 * Comment Processing Service
 *
 * Provides language-aware comment stripping with AST-based and regex fallback strategies.
 * Preserves newlines to maintain stack trace line numbers.
 *
 * Task 2.2: Comment Stripping Modes
 */
export class CommentProcessor implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private outputChannel: vscode.OutputChannel;
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    private configService: any,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;

    // Create status bar item for strip comments indicator
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'codingame.toggleStripComments';
    this.disposables.push(this.statusBarItem);

    // Subscribe to configuration changes
    this.disposables.push(
      this.configService.onConfigChange((event: any) => {
        if (event.stripComments || event.commentStrategy) {
          this.updateStatusBar();
          this.log('[COMMENT] Configuration changed, reloading processor');
        }
      })
    );

    this.updateStatusBar();
    this.statusBarItem.show();
  }

  /**
   * Process code based on current configuration
   * Main entry point for comment stripping
   */
  async processCode(code: string, languageId: string): Promise<ProcessResult> {
    const stripComments = this.configService.getStripComments();

    if (!stripComments) {
      return {
        code,
        strategy: 'none',
        stripped: false,
        originalLines: code.split('\n').length,
        resultLines: code.split('\n').length,
      };
    }

    const strategy = this.configService.getCommentStrategy();
    const verbose = this.configService.isVerboseLogging();

    if (verbose) {
      this.log(`[COMMENT] Processing ${languageId} code (${code.length} chars)`);
      this.log(`[COMMENT] Strategy: ${strategy}`);
    }

    try {
      let result: ProcessResult;

      if (strategy === 'none') {
        result = {
          code,
          strategy: 'none',
          stripped: false,
          originalLines: code.split('\n').length,
          resultLines: code.split('\n').length,
        };
      } else if (strategy === 'regex') {
        result = await this.stripWithRegex(code, languageId);
      } else {
        // Auto strategy: try AST first, fallback to regex
        result = await this.stripWithAuto(code, languageId);
      }

      if (verbose) {
        this.log(`[COMMENT] Result: ${result.strategy} strategy used`);
        this.log(`[COMMENT] Lines: ${result.originalLines} → ${result.resultLines}`);
        this.log(`[COMMENT] Size: ${code.length} → ${result.code.length} bytes`);
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[COMMENT] Error processing code: ${message}`, true);

      // Return original code on error
      return {
        code,
        strategy: 'error',
        stripped: false,
        originalLines: code.split('\n').length,
        resultLines: code.split('\n').length,
        error: message,
      };
    }
  }

  /**
   * Auto strategy: attempt AST-based stripping with regex fallback
   */
  private async stripWithAuto(code: string, languageId: string): Promise<ProcessResult> {
    // Try AST-based approach for supported languages
    const astResult = await this.tryAstStripping(code, languageId);

    if (astResult.success) {
      return {
        code: astResult.code,
        strategy: 'ast',
        stripped: true,
        originalLines: code.split('\n').length,
        resultLines: astResult.code.split('\n').length,
      };
    }

    // Fallback to regex
    this.log(`[COMMENT] AST failed for ${languageId}, falling back to regex`);
    const regexResult = await this.stripWithRegex(code, languageId);

    // Update status bar to show regex fallback
    if (regexResult.stripped) {
      this.showRegexWarning();
    }

    return regexResult;
  }

  /**
   * Attempt AST-based comment stripping for supported languages
   */
  private async tryAstStripping(code: string, languageId: string): Promise<AstResult> {
    const normalizedLang = this.normalizeLanguageId(languageId);

    switch (normalizedLang) {
      case 'python':
        return this.stripPythonAst(code);
      case 'javascript':
      case 'typescript':
        return this.stripJavaScriptAst(code);
      case 'cpp':
      case 'c':
        return this.stripCppAst(code);
      case 'java':
        return this.stripJavaAst(code);
      default:
        return { success: false, code };
    }
  }

  /**
   * Strip Python comments using AST-like approach
   */
  private stripPythonAst(code: string): AstResult {
    try {
      const lines = code.split('\n');
      const result: string[] = [];
      let inMultilineString = false;
      let stringDelimiter = '';

      for (const line of lines) {
        let processedLine = line;

        // Check for docstrings and multiline strings
        if (line.trim().startsWith('"""') || line.trim().startsWith("'''")) {
          const delimiter = line.trim().startsWith('"""') ? '"""' : "'''";
          const count = (line.match(new RegExp(delimiter, 'g')) || []).length;

          if (count === 1) {
            inMultilineString = !inMultilineString;
            stringDelimiter = delimiter;
          }

          // Keep the line (might be docstring)
          result.push(line);
          continue;
        }

        if (inMultilineString) {
          if (line.includes(stringDelimiter)) {
            inMultilineString = false;
          }
          result.push(line);
          continue;
        }

        // Find # comments outside strings
        let commentStart = -1;
        let currentQuote = '';

        for (let j = 0; j < line.length; j++) {
          const char = line[j];

          if ((char === '"' || char === "'") && (j === 0 || line[j - 1] !== '\\')) {
            if (!currentQuote) {
              currentQuote = char;
            } else if (char === currentQuote) {
              currentQuote = '';
            }
          } else if (char === '#' && !currentQuote) {
            commentStart = j;
            break;
          }
        }

        if (commentStart >= 0) {
          processedLine = line.substring(0, commentStart).trimEnd();
        }

        result.push(processedLine);
      }

      return { success: true, code: result.join('\n') };
    } catch (error) {
      return { success: false, code };
    }
  }

  /**
   * Strip JavaScript/TypeScript comments using AST-like approach
   */
  private stripJavaScriptAst(code: string): AstResult {
    try {
      const lines = code.split('\n');
      const result: string[] = [];
      let inMultilineComment = false;

      for (const line of lines) {
        let processedLine = '';
        let inString = false;
        let stringChar = '';
        let escaped = false;
        let i = 0;

        while (i < line.length) {
          const char = line[i];
          const nextChar = i + 1 < line.length ? line[i + 1] : '';

          // Handle escape sequences
          if (escaped) {
            processedLine += char;
            escaped = false;
            i++;
            continue;
          }

          if (char === '\\') {
            processedLine += char;
            escaped = true;
            i++;
            continue;
          }

          // Handle strings
          if ((char === '"' || char === "'" || char === '`') && !inMultilineComment) {
            if (!inString) {
              inString = true;
              stringChar = char;
            } else if (char === stringChar) {
              inString = false;
              stringChar = '';
            }
            processedLine += char;
            i++;
            continue;
          }

          if (inString) {
            processedLine += char;
            i++;
            continue;
          }

          // Handle comments
          if (inMultilineComment) {
            if (char === '*' && nextChar === '/') {
              inMultilineComment = false;
              i += 2;
            } else {
              i++;
            }
            continue;
          }

          if (char === '/' && nextChar === '/') {
            // Single-line comment - skip rest of line
            break;
          }

          if (char === '/' && nextChar === '*') {
            // Start of multiline comment
            inMultilineComment = true;
            i += 2;
            continue;
          }

          // Regular character
          processedLine += char;
          i++;
        }

        result.push(processedLine.trimEnd());
      }

      return { success: true, code: result.join('\n') };
    } catch (error) {
      return { success: false, code };
    }
  }

  /**
   * Strip C/C++ comments using AST-like approach
   */
  private stripCppAst(code: string): AstResult {
    // C++ comment syntax is similar to JavaScript
    return this.stripJavaScriptAst(code);
  }

  /**
   * Strip Java comments using AST-like approach
   */
  private stripJavaAst(code: string): AstResult {
    // Java comment syntax is similar to JavaScript
    return this.stripJavaScriptAst(code);
  }

  /**
   * Strip comments using regex patterns (fallback strategy)
   */
  private async stripWithRegex(code: string, languageId: string): Promise<ProcessResult> {
    const normalizedLang = this.normalizeLanguageId(languageId);
    const originalLines = code.split('\n').length;

    try {
      let processed = code;

      switch (normalizedLang) {
        case 'python':
          processed = this.stripPythonRegex(code);
          break;
        case 'javascript':
        case 'typescript':
        case 'java':
        case 'cpp':
        case 'c':
        case 'csharp':
          processed = this.stripCStyleRegex(code);
          break;
        case 'ruby':
        case 'perl':
        case 'bash':
        case 'shell':
          processed = this.stripHashCommentRegex(code);
          break;
        case 'rust':
          processed = this.stripRustRegex(code);
          break;
        default:
          this.log(`[COMMENT] Unsupported language: ${languageId}`, true);
          return {
            code,
            strategy: 'regex',
            stripped: false,
            originalLines,
            resultLines: code.split('\n').length,
            error: `Unsupported language: ${languageId}`,
          };
      }

      return {
        code: processed,
        strategy: 'regex',
        stripped: true,
        originalLines,
        resultLines: processed.split('\n').length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[COMMENT] Regex stripping failed: ${message}`, true);

      return {
        code,
        strategy: 'regex',
        stripped: false,
        originalLines,
        resultLines: code.split('\n').length,
        error: message,
      };
    }
  }

  /**
   * Strip Python comments using regex
   */
  private stripPythonRegex(code: string): string {
    const lines = code.split('\n');
    return lines.map(line => {
      // Simple approach: remove # comments not in strings
      // This is imperfect but better than nothing
      const match = line.match(/^([^#"']*(?:["'][^"']*["'][^#"']*)*)#.*$/);
      if (match) {
        return match[1].trimEnd();
      }
      return line;
    }).join('\n');
  }

  /**
   * Strip C-style comments (Java, C++, C#, JavaScript, TypeScript)
   */
  private stripCStyleRegex(code: string): string {
    // Remove single-line comments
    let processed = code.replace(/\/\/.*$/gm, '');

    // Remove multi-line comments while preserving newlines
    processed = processed.replace(/\/\*[\s\S]*?\*\//g, (match) => {
      // Replace with same number of newlines
      const newlines = (match.match(/\n/g) || []).length;
      return '\n'.repeat(newlines);
    });

    return processed;
  }

  /**
   * Strip hash-style comments (Ruby, Perl, Bash)
   */
  private stripHashCommentRegex(code: string): string {
    const lines = code.split('\n');
    return lines.map(line => {
      return line.replace(/#.*$/, '').trimEnd();
    }).join('\n');
  }

  /**
   * Strip Rust comments
   */
  private stripRustRegex(code: string): string {
    // Rust uses // and /* */ like C/C++
    return this.stripCStyleRegex(code);
  }

  /**
   * Normalize language ID to canonical form
   */
  private normalizeLanguageId(languageId: string): string {
    const normalized = languageId.toLowerCase().replace(/[^a-z]/g, '');

    const mappings: Record<string, string> = {
      'python': 'python',
      'python3': 'python',
      'py': 'python',
      'javascript': 'javascript',
      'js': 'javascript',
      'typescript': 'typescript',
      'ts': 'typescript',
      'java': 'java',
      'cpp': 'cpp',
      'cplusplus': 'cpp',
      'c': 'c',
      'csharp': 'csharp',
      'cs': 'csharp',
      'ruby': 'ruby',
      'rb': 'ruby',
      'perl': 'perl',
      'pl': 'perl',
      'bash': 'bash',
      'sh': 'bash',
      'shell': 'shell',
      'rust': 'rust',
      'rs': 'rust',
    };

    return mappings[normalized] || normalized;
  }

  /**
   * Update status bar item display
   */
  private updateStatusBar(): void {
    const stripComments = this.configService.getStripComments();
    const strategy = this.configService.getCommentStrategy();

    if (stripComments) {
      this.statusBarItem.text = `$(comment) Strip: ON (${strategy})`;
      this.statusBarItem.tooltip = `Comment stripping enabled (${strategy} strategy)\nClick to toggle`;
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = `$(comment) Strip: OFF`;
      this.statusBarItem.tooltip = 'Comment stripping disabled\nClick to toggle';
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  /**
   * Show regex fallback warning in status bar
   */
  private showRegexWarning(): void {
    const originalText = this.statusBarItem.text;
    this.statusBarItem.text = `$(warning) ${originalText} (regex)`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // Reset after 3 seconds
    setTimeout(() => {
      this.updateStatusBar();
    }, 3000);
  }

  /**
   * Get processing statistics
   */
  getStats(original: string, processed: string): CommentStats {
    const originalLines = original.split('\n');
    const processedLines = processed.split('\n');

    const originalSize = original.length;
    const processedSize = processed.length;
    const reduction = originalSize - processedSize;
    const reductionPercent = originalSize > 0 ? (reduction / originalSize) * 100 : 0;

    return {
      originalLines: originalLines.length,
      processedLines: processedLines.length,
      originalSize,
      processedSize,
      bytesReduced: reduction,
      reductionPercent: Math.round(reductionPercent * 100) / 100,
    };
  }

  /**
   * Log message to output channel
   */
  private log(message: string, isError: boolean = false): void {
    const timestamp = new Date().toISOString();
    const prefix = isError ? '[ERROR]' : '[INFO]';
    this.outputChannel.appendLine(`${timestamp} ${prefix} ${message}`);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

/**
 * Result of comment processing
 */
export interface ProcessResult {
  code: string;
  strategy: 'none' | 'ast' | 'regex' | 'error';
  stripped: boolean;
  originalLines: number;
  resultLines: number;
  error?: string;
}

/**
 * Internal AST processing result
 */
interface AstResult {
  success: boolean;
  code: string;
}

/**
 * Comment processing statistics
 */
export interface CommentStats {
  originalLines: number;
  processedLines: number;
  originalSize: number;
  processedSize: number;
  bytesReduced: number;
  reductionPercent: number;
}
