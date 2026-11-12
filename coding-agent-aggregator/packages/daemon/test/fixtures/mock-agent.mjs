// Mock coding-agent CLI for tests. Usage: node mock-agent.mjs --task "<STEP>;;<STEP>..."
// Steps: WRITE <file> <content> | SAY <text> | ASK <command> | RATELIMIT | SLEEP <ms> | EXIT <code>
import { writeFileSync } from 'node:fs';

const taskIdx = process.argv.indexOf('--task');
const steps = (taskIdx >= 0 ? process.argv[taskIdx + 1] : '').split(';;').map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readAnswer() {
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(d) {
      const m = /[yn]/i.exec(d);
      if (m) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolve(m[0].toLowerCase());
      }
    });
  });
}

for (const step of steps) {
  const [cmd, ...rest] = step.split(' ');
  const arg = rest.join(' ');
  if (cmd === 'WRITE') {
    const [file, ...content] = rest;
    writeFileSync(file, content.join(' ') + '\n');
    console.log(`wrote ${file}`);
  } else if (cmd === 'SAY') {
    console.log(arg);
  } else if (cmd === 'ASK') {
    process.stdout.write(`\u001b[33mAllow command: ${arg} ? (y/n)\u001b[0m `);
    const answer = await readAnswer();
    console.log(`\nANSWER:${answer}`);
  } else if (cmd === 'RATELIMIT') {
    console.log('Error: 429 rate limit exceeded, try again in 30 seconds');
    await sleep(60_000);
  } else if (cmd === 'SLEEP') {
    await sleep(Number(arg));
  } else if (cmd === 'EXIT') {
    process.exit(Number(arg));
  }
}
