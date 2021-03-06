#! /usr/bin/env node
const yargs = require('yargs');
const { spawn } = require('child_process');
const kill = require('tree-kill');
const getPort = require('get-port');
const puppeteer = require('puppeteer');

const argv = yargs
  .string('package')
  .string('release')
  .string('test-app-path')
  .boolean('once')
  .boolean('inspect')
  .boolean('inspect-brk')
  .number('port')
  .argv;

if (!argv.package) {
  console.warn('no package name provided');
  process.exit(1);
}

let meteor;
let browser;
let exiting = false;

function exit() {
  exiting = true;
  if (meteor) {
    kill(meteor.pid);
  }
  if (browser) {
    browser.close();
    browser = null;
  }
}

process.on("SIGINT", function() {
  exit();
  process.exit();
});
process.on('exit', () => {
  exit();
});

function startMeteor (port) {
  let executable = 'meteor';
  let args = [
    'test-packages',
    '--driver-package',
    'test-in-console',
    '-p',
    port,
    argv.package
  ];

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
    args.push('--test-app-path', argv.testAppPath)
  }
  
  if (/^win/.test(process.platform)) {
    executable = process.env.comspec || 'cmd.exe';
    args = ['/c', 'meteor'].concat(args);
  }
  
  meteor = spawn(executable, args, {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  meteor.stdout.pipe(process.stdout);
  meteor.stderr.pipe(process.stderr);
  meteor.stdout.on('data', function meteorRunning(data) {
    var data = data.toString();
    if(data.match(/10015|test-in-console listening/)) {
      meteor.stdout.removeListener('data', meteorRunning);
      startChrome(port);
    }
  });
  
  meteor.on('close', code => {
    if (exiting) {
      return;
    }

    console.log(`Meteor process exited with code ${code}`);
    meteor = null;
    process.exitCode = 1;
    exit();
  });
}

(async () => {
  const ports = []
  for(let i = 10000; i < 12000; i++) {
    ports.push(i);
  }

  const port = argv.port ? argv.port : await getPort({  port: ports.sort(() => Math.random() - 0.5) });
  startMeteor(port);
})();

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
    if (exiting) {
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
