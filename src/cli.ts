#!/usr/bin/env node
import chalk from 'chalk';
import { createProgram } from './cli-program.js';
import { AgentCtlError } from './core/errors.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof AgentCtlError) {
    console.error(chalk.red(`错误 [${error.code}]：${error.message}`));
    if (error.remediation) console.error(chalk.yellow(`解决方法：${error.remediation}`));
    process.exitCode = error.exitCode;
  } else {
    console.error(chalk.red(`错误：${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  }
}
