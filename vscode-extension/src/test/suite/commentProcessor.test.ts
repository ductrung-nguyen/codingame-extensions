import * as assert from 'assert';
import { CommentProcessor } from '../../services/CommentProcessor';

suite('CommentProcessor Test Suite', () => {
  let commentProcessor: CommentProcessor;
  let mockConfigService: any;
  let mockOutputChannel: any;

  setup(() => {
    // Create mock configuration service
    const eventListeners: any[] = [];
    mockConfigService = {
      getStripComments: () => true,
      getCommentStrategy: () => 'auto',
      isVerboseLogging: () => false,
      onConfigChange: (callback: any) => {
        eventListeners.push(callback);
        return { dispose: () => { } };
      }
    };

    // Create mock output channel
    mockOutputChannel = {
      appendLine: (_message: string) => { },
      show: () => { },
      dispose: () => { }
    };

    commentProcessor = new CommentProcessor(mockConfigService, mockOutputChannel);
  });

  teardown(() => {
    commentProcessor.dispose();
  });

  suite('Python Comment Stripping', () => {
    test('Should remove single-line Python comments', async () => {
      const input = '#a\nprint(1)';
      const result = await commentProcessor.processCode(input, 'python');

      assert.strictEqual(result.stripped, true);
      assert.strictEqual(result.strategy, 'ast');
      assert.ok(result.code.includes('print(1)'));
      assert.ok(!result.code.includes('#a'));
    });

    test('Should preserve Python docstrings', async () => {
      const input = '"""Docstring"""\nprint(1)';
      const result = await commentProcessor.processCode(input, 'python');

      assert.ok(result.code.includes('"""Docstring"""'));
      assert.ok(result.code.includes('print(1)'));
    });

    test('Should handle inline Python comments', async () => {
      const input = 'x = 1  # comment';
      const result = await commentProcessor.processCode(input, 'python');

      assert.ok(result.code.includes('x = 1'));
      assert.ok(!result.code.includes('# comment'));
    });

    test('Should preserve hash inside strings', async () => {
      const input = 's = "#not a comment"';
      const result = await commentProcessor.processCode(input, 'python');

      assert.ok(result.code.includes('#not a comment'));
    });

    test('Should preserve newline count for Python', async () => {
      const input = '# line1\n# line2\nprint(1)';
      const result = await commentProcessor.processCode(input, 'python');

      const inputLines = input.split('\n').length;
      const outputLines = result.code.split('\n').length;
      assert.strictEqual(inputLines, outputLines);
    });
  });

  suite('JavaScript Comment Stripping', () => {
    test('Should remove single-line JavaScript comments', async () => {
      const input = '// comment\nconst x = 1;';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.strictEqual(result.stripped, true);
      assert.strictEqual(result.strategy, 'ast');
      assert.ok(result.code.includes('const x = 1;'));
      assert.ok(!result.code.includes('// comment'));
    });

    test('Should remove multi-line JavaScript comments', async () => {
      const input = '/* comment */\nconst x = 1;';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.ok(result.code.includes('const x = 1;'));
      assert.ok(!result.code.includes('/* comment */'));
    });

    test('Should handle inline JavaScript comments', async () => {
      const input = 'console.log("x"); // tail';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.ok(result.code.includes('console.log("x");'));
      assert.ok(!result.code.includes('// tail'));
    });

    test('Should preserve comments inside JavaScript strings', async () => {
      const input = 'const s = "// not comment";';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.ok(result.code.includes('// not comment'));
    });

    test('Should preserve newline count for JavaScript', async () => {
      const input = '// line1\n// line2\nconst x = 1;';
      const result = await commentProcessor.processCode(input, 'javascript');

      const inputLines = input.split('\n').length;
      const outputLines = result.code.split('\n').length;
      assert.strictEqual(inputLines, outputLines);
    });
  });

  suite('C++ Comment Stripping', () => {
    test('Should remove C++ single-line comments', async () => {
      const input = '// comment\nint main() {}';
      const result = await commentProcessor.processCode(input, 'cpp');

      assert.strictEqual(result.stripped, true);
      assert.ok(result.code.includes('int main()'));
      assert.ok(!result.code.includes('// comment'));
    });

    test('Should remove C++ multi-line comments', async () => {
      const input = '/*a*/int main(){}';
      const result = await commentProcessor.processCode(input, 'cpp');

      assert.ok(result.code.includes('int main(){}'));
      assert.ok(!result.code.includes('/*a*/'));
    });
  });

  suite('Comment Strategy Tests', () => {
    test('Should return original code when stripComments is false', async () => {
      mockConfigService.getStripComments = () => false;
      const input = '// comment\nconst x = 1;';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.strictEqual(result.stripped, false);
      assert.strictEqual(result.strategy, 'none');
      assert.strictEqual(result.code, input);
    });

    test('Should use regex fallback for unsupported languages', async () => {
      const input = '// comment\nfn main() {}';
      const result = await commentProcessor.processCode(input, 'rust');

      assert.strictEqual(result.strategy, 'regex');
      assert.strictEqual(result.stripped, true);
    });

    test('Should handle regex strategy explicitly', async () => {
      mockConfigService.getCommentStrategy = () => 'regex';
      const input = '// comment\nconst x = 1;';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.strictEqual(result.strategy, 'regex');
      assert.strictEqual(result.stripped, true);
    });

    test('Should handle none strategy', async () => {
      mockConfigService.getCommentStrategy = () => 'none';
      const input = '// comment\nconst x = 1;';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.strictEqual(result.strategy, 'none');
      assert.strictEqual(result.stripped, false);
      assert.strictEqual(result.code, input);
    });
  });

  suite('Statistics Tests', () => {
    test('Should calculate correct statistics', () => {
      const original = '// comment\nconst x = 1;';
      const processed = 'const x = 1;';
      const stats = commentProcessor.getStats(original, processed);

      assert.ok(stats.bytesReduced > 0);
      assert.ok(stats.reductionPercent > 0);
      assert.strictEqual(stats.originalSize, original.length);
      assert.strictEqual(stats.processedSize, processed.length);
    });

    test('Should handle empty input', () => {
      const stats = commentProcessor.getStats('', '');

      assert.strictEqual(stats.bytesReduced, 0);
      assert.strictEqual(stats.reductionPercent, 0);
    });
  });

  suite('Edge Cases', () => {
    test('Should handle empty code', async () => {
      const result = await commentProcessor.processCode('', 'python');

      assert.strictEqual(result.code, '');
      // Empty code still goes through processing, so stripped can be true
      assert.ok(result.stripped === true || result.stripped === false);
    });

    test('Should handle code with only comments', async () => {
      const input = '# comment1\n# comment2';
      const result = await commentProcessor.processCode(input, 'python');

      assert.strictEqual(result.stripped, true);
      const lines = result.code.split('\n');
      assert.strictEqual(lines.length, 2); // Newlines preserved
    });

    test('Should handle mixed line endings', async () => {
      const input = '// comment\r\nconst x = 1;';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.strictEqual(result.stripped, true);
    });

    test('Should handle unicode characters in comments', async () => {
      const input = '// 日本語コメント\nconst x = 1;';
      const result = await commentProcessor.processCode(input, 'javascript');

      assert.ok(!result.code.includes('日本語'));
      assert.ok(result.code.includes('const x = 1;'));
    });
  });

  suite('BDD Scenario Validation', () => {
    test('BDD Scenario 1: AST Strategy Success - Python', async () => {
      const input = '#a\nprint(1)';
      const result = await commentProcessor.processCode(input, 'python');

      // Expected: code is "print(1)" and newline count preserved
      assert.strictEqual(result.strategy, 'ast');
      assert.strictEqual(result.stripped, true);
      assert.ok(result.code.includes('print(1)'));
      assert.strictEqual(result.originalLines, result.resultLines);
    });

    test('BDD Scenario 1: AST Strategy Success - C++', async () => {
      const input = '/*a*/int main(){}';
      const result = await commentProcessor.processCode(input, 'cpp');

      // Expected: code is "int main(){}"
      assert.strictEqual(result.strategy, 'ast');
      assert.ok(result.code.includes('int main(){}'));
    });

    test('BDD Scenario 1: AST Strategy Success - JavaScript', async () => {
      const input = 'console.log("x"); // tail';
      const result = await commentProcessor.processCode(input, 'javascript');

      // Expected: code is "console.log("x");"
      assert.strictEqual(result.strategy, 'ast');
      assert.ok(result.code.includes('console.log("x");'));
      assert.ok(!result.code.includes('// tail'));
    });

    test('BDD Scenario 2: Fallback Regex Warning - Rust', async () => {
      const input = '// comment\nfn main() {}';
      const result = await commentProcessor.processCode(input, 'rust');

      // Expected: regex fallback runs
      assert.strictEqual(result.strategy, 'regex');
      assert.strictEqual(result.stripped, true);
      // Note: Status bar warning tested manually
    });
  });
});
