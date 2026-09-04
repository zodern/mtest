#! /usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import getPort from 'get-port';
import puppeteer from 'puppeteer';
import kill from 'tree-kill';
import yargs from 'yargs';

const argv = yargs(process.argv.slice(2))
  .string('package')
  .string('release')
  .string('settings')
  .string('test-app-path')
  .string('meteor-path')
  .boolean('once')
  .boolean('inspect')
  .boolean('inspect-brk')
  .boolean('cache')
  .number('port')
  .parse();

const execFileAsync = promisify(execFile);

async function killAsync (pid) {
  return new Promise((resolve, reject) => {
    return kill(pid, (error) => {
      if (error) {
        return reject(error);
      }

      resolve();
    });
  });
}

let meteor;
let browser;
let installer;
let exitPromise;

async function exit() {
  if (exitPromise) {
    return exitPromise;
  }

  let promises = [];
  if (meteor) {
    promises.push(killAsync(meteor.pid));
  }
  if (installer) {
    promises.push(killAsync(installer.pid));
    installer = null;
  }
  if (browser) {
    promises.push(browser.close());
    browser = null;
  }

  exitPromise = Promise.allSettled(promises);

  return exitPromise;
}

process.on("SIGINT", async function() {
  await exit();
  process.exit(130);
});
process.on("SIGTERM", async function() {
  await exit();
  process.exit(143);
});

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

async function ensureBrowserInstalled() {
  const configuration = await puppeteer.configuration();
  const browserName = configuration.defaultBrowser;

  if (configuration.executablePath || configuration[browserName]?.skipDownload) {
    return;
  }

  const executablePath = await puppeteer.executablePath();
  try {
    await fs.promises.access(executablePath, fs.constants.X_OK);
    return;
  } catch {
    // Many package managers don't run lifecycle scripts
    // Download now instead
  }

  const packageUrl = import.meta.resolve('puppeteer/package.json');
  const packageJson = JSON.parse(
    await fs.promises.readFile(new URL(packageUrl), 'utf8')
  );
  const bin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.puppeteer;

  if (!bin) {
    throw new Error('Unable to find the puppeteer cli to download the browser with');
  }

  const cliPath = fileURLToPath(new URL(bin, packageUrl));

  console.log(`${browserName} is not installed; downloading it now...`);

  const installing = execFileAsync(process.execPath, [
    cliPath,
    'browsers',
    'install',
    browserName
  ]);

  installer = installing.child;

  try {
    await installing;
  } catch (error) {
    // The cli prints its whole help text before the error, so drop everything
    // before the error itself
    const output = (error.stderr || '').trim();
    const start = output.search(/^Error:/m);
    const details = start === -1 ? output : output.slice(start);

    // Falls back to the message for failures with no output, such as a bad spawn
    throw new Error(details || error.message, { cause: error });
  } finally {
    installer = null;
  }

  console.log(`${browserName} installed.`);
}

function startMeteor (port, browserReady) {
  let executable = argv.meteorPath || 'meteor';
  let args = [
    'test-packages',
    '--driver-package',
    'test-in-console',
    '-p',
    port,
    argv.package
  ];
  let env = Object.assign({}, process.env);

  if (argv.once) {
    args.push('--once');
  }
  if (argv.release) {
    args.push('--release', argv.release);
  }
  if (argv.inspect) {
    args.push('--inspect');
  }
  if (argv.inspectBrk) {
    args.push('--inspect-brk');
  }
  if (argv.testAppPath) {
    args.push('--test-app-path', argv.testAppPath);
  }
  if (argv.settings) {
    args.push('--settings', argv.settings);
  }

  if (argv.cache) {
    let pathHash = sha1(JSON.stringify({
      cwd: process.cwd(),
      testAppPath: argv.testAppPath,
    }));

    let folder = path.resolve(os.tmpdir(), `mtest-1-${pathHash}`);

    fs.mkdirSync(folder, { recursive: true });

    fs.rmSync(path.join(folder, 'db'), { recursive: true, force: true });
    fs.rmSync(path.join(folder, 'dbs'), { recursive: true, force: true });

    env.METEOR_LOCAL_DIR = folder;
    console.log(`Using ${folder} for build cache`);
  }
  
  if (/^win/.test(process.platform)) {
    args = ['/c', executable].concat(args);
    executable = process.env.comspec || 'cmd.exe';
  }
  
  meteor = spawn(executable, args, {
    cwd: process.cwd(),
    stdio: 'pipe',
    env
  });
  meteor.stdout.pipe(process.stdout);
  meteor.stderr.pipe(process.stderr);
  meteor.stdout.on('data', function meteorRunning(data) {
    var data = data.toString();
    if(data.match(/10015|test-in-console listening/)) {
      meteor.stdout.removeListener('data', meteorRunning);
      browserReady.then(isReady => {
        if (!isReady || exitPromise) {
          return;
        }

        return startChrome(port);
      }).catch(async (err) => {
        console.error(`Error running chrome:`);
        console.error(err);
        await exit();
        process.exit(1);
      });
    }
  });

  meteor.on('close', code => {
    if (exitPromise) {
      return;
    }

    console.log(`Meteor process exited with code ${code}`);
    meteor = null;
    process.exitCode = 1;
    exit();
  });
}

async function main() {
  if (!argv.package) {
    console.warn('no package name provided');
    process.exitCode = 1;
    return;
  }

  const ports = []
  for(let i = 10000; i < 12000; i++) {
    ports.push(i);
  }

  const port = argv.port ? argv.port : await getPort({  port: ports.sort(() => Math.random() - 0.5) });
  const browserReady = ensureBrowserInstalled().then(
    () => true,
    async error => {
      if (exitPromise) {
        return false;
      }

      console.error('Error installing browser:');
      console.error(error.message);
      await exit();
      process.exitCode = 1;
      return false;
    }
  );

  startMeteor(port, browserReady);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function testsDone (page) {
  return page.evaluate(() => {
    if (typeof Package !== 'undefined' && Package['test-in-console']) {
      return Package['test-in-console'].TEST_STATUS.DONE;
    }

    return false;
  });
}

function checkFailures (page) {
  return page.evaluate(function () {
    return Package['test-in-console'].TEST_STATUS.FAILURES;
  });
}

async function testsFinish(page) {
  while(true) {
    await sleep(500);
    let done = await testsDone(page);

    if (done) {
      return checkFailures(page);
    }
  }
}

async function startChrome(port) {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  let page = await browser.newPage();

  let tries = 0;
  while(true) {
    if (exitPromise) {
      return;
    }
    if (tries > 10) {
      console.log('Unable to load page');
      return exit();
    }
    try {
      await page.goto(`http://localhost:${port}`);
      break;
    } catch (e) {
      tries += 1
      await sleep(1000);
    }
  }

  page.on('console', msg => {
    let text = msg.text();
    if (text !== '##_meteor_magic##state: done') {
      console.log(text);
    }
  });
  console.log('Running tests...');
  
  const failureCode = await testsFinish(page);

  if (argv.once) {
    process.exitCode = failureCode;
    exit();
  }
}
