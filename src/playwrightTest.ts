/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawn } from 'child_process';
import path from 'path';
import { debugSessionName } from './debugSessionName';
import { ConfigListFilesReport } from './listTests';
import { Entry, StepBeginParams, StepEndParams, TestBeginParams, TestEndParams } from './oopReporter';
import type { TestError } from './reporter';
import { ReporterServer } from './reporterServer';
import { ReusedBrowser } from './reusedBrowser';
import { findNode, spawnAsync } from './utils';
import * as vscodeTypes from './vscodeTypes';

export type TestConfig = {
  workspaceFolder: string;
  configFile: string;
  cli: string;
  version: number;
  testIdAttributeName?: string;
};

export interface TestListener {
  onBegin?(params: { projects: Entry[] }): void;
  onTestBegin?(params: TestBeginParams): void;
  onTestEnd?(params: TestEndParams): void;
  onStepBegin?(params: StepBeginParams): void;
  onStepEnd?(params: StepEndParams): void;
  onError?(params: { error: TestError }): void;
  onEnd?(): void;
  onStdOut?(data: Buffer | string): void;
  onStdErr?(data: Buffer | string): void;
}

const pathSeparator = process.platform === 'win32' ? ';' : ':';

export class PlaywrightTest {
  private _testLog: string[] = [];
  private _isUnderTest: boolean;
  private _reusedBrowser: ReusedBrowser;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _vscode: vscodeTypes.VSCode;

  constructor(vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser, isUnderTest: boolean, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._reusedBrowser = reusedBrowser;
    this._isUnderTest = isUnderTest;
    this._envProvider = envProvider;
  }

  async getPlaywrightInfo(workspaceFolder: string, configFilePath: string): Promise<{ version: number, cli: string } | null> {
    try {
      const pwtInfo = await this._runNode([
        '-e',
        'try { const pwtIndex = require.resolve("@playwright/test"); const version = require("@playwright/test/package.json").version; console.log(JSON.stringify({ pwtIndex, version})); } catch { console.log("undefined"); }',
      ], path.dirname(configFilePath));
      const { version } = JSON.parse(pwtInfo);
      const v = parseFloat(version.replace(/-(next|beta)$/, ''));

      // We only depend on playwright-core in 1.15+, bail out.
      if (v < 1.19)
        return { cli: '', version: v };

      const cliInfo = await this._runNode([
        '-e',
        'try { const cli = require.resolve("@playwright/test/cli"); console.log(JSON.stringify({ cli })); } catch { console.log("undefined"); }',
      ], path.dirname(configFilePath));
      let { cli } = JSON.parse(cliInfo);

      // Dogfood for 'ttest'
      if (cli.includes('packages/playwright-test') && configFilePath.includes('playwright-test'))
        cli = path.join(workspaceFolder, 'tests/playwright-test/stable-test-runner/node_modules/playwright-core/lib/cli/cli');

      return { cli, version: v };
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  async listFiles(config: TestConfig): Promise<ConfigListFilesReport | null> {
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const allArgs = [config.cli, 'list-files', '-c', configFile];
    {
      // For tests.
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> playwright list-files -c ${configFile}`);
    }
    const output = await this._runNode(allArgs, configFolder);
    try {
      return JSON.parse(output) as ConfigListFilesReport;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async runTests(config: TestConfig, projectNames: string[], locations: string[] | null, listener: TestListener, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
    const locationArg = locations ? locations : [];
    const args = projectNames.filter(Boolean).map(p => `--project=${p}`);
    if (parametrizedTestTitle)
      args.push(`--grep=${escapeRegex(parametrizedTestTitle)}`);
    if (token?.isCancellationRequested)
      return;
    await this._reusedBrowser.willRunTests(config, false);
    try {
      if (token?.isCancellationRequested)
        return;
      await this._test(config, locationArg,  args, listener, 'run', token);
    } finally {
      await this._reusedBrowser.didRunTests(false);
    }
  }

  async listTests(config: TestConfig, files: string[]): Promise<{ entries: Entry[], errors: TestError[] }> {
    let entries: Entry[] = [];
    const errors: TestError[] = [];
    await this._test(config, files, ['--list'], {
      onBegin: params => {
        entries = params.projects as Entry[];
      },
      onError: params => {
        errors.push(params.error);
      },
    }, 'list', new this._vscode.CancellationTokenSource().token);
    return { entries, errors };
  }

  private async _test(config: TestConfig, locations: string[], args: string[], listener: TestListener, mode: 'list' | 'run', token: vscodeTypes.CancellationToken): Promise<void> {
    // Playwright will restart itself as child process in the ESM mode and won't inherit the 3/4 pipes.
    // Always use ws transport to mitigate it.
    const reporterServer = new ReporterServer();
    const node = await findNode();
    if (token?.isCancellationRequested)
      return;
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const escapedLocations = locations.map(escapeRegex);
    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f)).map(escapeRegex);
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> playwright test -c ${configFile}${args.length ? ' ' + args.join(' ') : ''}${relativeLocations.length ? ' ' + relativeLocations.join(' ') : ''}`);
    }
    const allArgs = [config.cli, 'test',
      '-c', configFile,
      ...args,
      ...escapedLocations,
      '--repeat-each', '1',
      '--retries', '0',
    ];
    const reusingBrowser = !!this._reusedBrowser.browserServerEnv(false);
    if (reusingBrowser && !this._isUnderTest)
      allArgs.push('--headed');
    if (reusingBrowser)
      allArgs.push('--workers', '1');
    // Disable original reporters when listing files.
    if (mode === 'list')
      allArgs.push('--reporter', 'null');
    const childProcess = spawn(node, allArgs, {
      cwd: configFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: this._isUnderTest ? undefined : process.env.CI,
        // Don't debug tests when running them.
        NODE_OPTIONS: undefined,
        ...this._envProvider(),
        ...this._reusedBrowser.browserServerEnv(false),
        ...(await reporterServer.env()),
        // Reset VSCode's options that affect nested Electron.
        ELECTRON_RUN_AS_NODE: undefined,
        FORCE_COLORS: '1',
        PW_TEST_HTML_REPORT_OPEN: 'never',
      }
    });

    const stdio = childProcess.stdio;
    stdio[1].on('data', data => listener.onStdOut?.(data));
    stdio[2].on('data', data => listener.onStdErr?.(data));
    await reporterServer.wireTestListener(listener, token);
  }

  async debugTests(vscode: vscodeTypes.VSCode, config: TestConfig, projectNames: string[], testDirs: string[], settingsEnv: NodeJS.ProcessEnv, locations: string[] | null, listener: TestListener, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    locations = locations || [];
    const escapedLocations = locations.map(escapeRegex);
    const args = ['test',
      '-c', configFile,
      ...escapedLocations,
      '--headed',
      ...projectNames.filter(Boolean).map(p => `--project=${p}`),
      '--repeat-each', '1',
      '--retries', '0',
      '--timeout', '0',
      '--workers', '1'
    ];
    if (parametrizedTestTitle)
      args.push(`--grep=${escapeRegex(parametrizedTestTitle)}`);

    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f)).map(escapeRegex);
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> debug -c ${configFile}${relativeLocations.length ? ' ' + relativeLocations.join(' ') : ''}`);
    }

    const reporterServer = new ReporterServer();
    await this._reusedBrowser.willRunTests(config, true);
    try {
      await vscode.debug.startDebugging(undefined, {
        type: 'pwa-node',
        name: debugSessionName,
        request: 'launch',
        cwd: configFolder,
        env: {
          ...process.env,
          CI: this._isUnderTest ? undefined : process.env.CI,
          ...settingsEnv,
          ...this._reusedBrowser.browserServerEnv(true),
          ...(await reporterServer.env()),
          // Reset VSCode's options that affect nested Electron.
          ELECTRON_RUN_AS_NODE: undefined,
          FORCE_COLORS: '1',
          PW_TEST_SOURCE_TRANSFORM: require.resolve('./debugTransform'),
          PW_TEST_SOURCE_TRANSFORM_SCOPE: testDirs.join(pathSeparator),
          PW_TEST_HTML_REPORT_OPEN: 'never',
          PWDEBUG: 'console',
        },
        program: config.cli,
        args,
      });
      await reporterServer.wireTestListener(listener, token);
    } finally {
      await this._reusedBrowser.didRunTests(true);
    }
  }

  private _log(line: string) {
    this._testLog.push(line);
  }

  testLog(): string[] {
    return this._testLog.slice();
  }

  private async _runNode(args: string[], cwd: string): Promise<string> {
    return await spawnAsync(await findNode(), args, cwd, this._envProvider());
  }
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
