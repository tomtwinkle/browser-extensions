'use strict';

const fs = require('node:fs');
const path = require('node:path');

const workflowDir = path.join('.github', 'workflows');
const repoConfigFiles = ['.goreleaser.yml'];
const shaRe = /^[0-9a-f]{40}$/;
const usesRe = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/;
const hfMainRe = /https:\/\/huggingface\.co\/[^/\s]+\/[^/\s]+\/resolve\/main\//;

function collectErrors(filePath) {
  const errors = [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const match = line.match(usesRe);
    if (match) {
      const reference = match[1];
      const isLocalReference =
        reference.startsWith('./') || reference.startsWith('docker://');
      if (!isLocalReference) {
        if (!reference.includes('@')) {
          errors.push(
            `${filePath}:${lineNo}: missing @ref in uses: ${reference}`
          );
        } else {
          const ref = reference.slice(reference.lastIndexOf('@') + 1);
          if (!shaRe.test(ref)) {
            errors.push(
              `${filePath}:${lineNo}: action ref is not pinned to a 40-char commit SHA: ${reference}`
            );
          }
        }
      }
    }

    if (hfMainRe.test(line)) {
      errors.push(
        `${filePath}:${lineNo}: mutable Hugging Face resolve/main URL must be pinned to an immutable revision`
      );
    }
  }

  return errors;
}

function main() {
  const errors = [];

  for (const entry of fs.readdirSync(workflowDir).sort()) {
    if (!entry.endsWith('.yml')) continue;
    errors.push(...collectErrors(path.join(workflowDir, entry)));
  }

  for (const configFile of repoConfigFiles) {
    if (!fs.existsSync(configFile)) continue;
    errors.push(...collectErrors(configFile));
  }

  if (errors.length > 0) {
    console.error('CI pinning check failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('CI pinning check passed.');
}

main();
