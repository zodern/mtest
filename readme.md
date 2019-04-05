# mtest

Small cli tool to test Meteor packages with Tiny Test in the terminal.

Install with
```bash
npm i -g @zodern/mtest
```

Test a package with
```bash
mtest --package <package name>
```

The package's client tests are run in headless Chrome. The test results are shown in the terminal.

By default, the tests re-run when a file changes. To disable this, use the `--once` option.
