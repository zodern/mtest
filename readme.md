# mtest

Small cli tool to test Meteor packages with Tiny Test in the terminal.

Requires Node.js 22.12 or newer.

Install with
```bash
npm i -g @zodern/mtest
```

Test a package with
```bash
mtest --package <package name>
```

The package's client tests are run in headless Chrome. The test results are shown in the terminal.
If your package manager blocks Puppeteer's install script, mtest downloads the compatible Chrome build.

By default, the tests re-run when a file changes. To disable this, use the `--once` option.

To reuse Meteor's local build cache between runs, use the `--cache` option:
```bash
mtest --package <package name> --cache
```

The local MongoDB data from the previous run is cleared at the start of each cached run.
Concurrent runs for the same package with the `--cache` option is not supported.

A local checkout of Meteor can be used with the `--meteor-path` option.
